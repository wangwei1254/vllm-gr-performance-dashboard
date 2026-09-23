"""Build the vllm-gr daily performance page from compact run summaries."""

from __future__ import annotations

import argparse
import json
from datetime import date, datetime
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "vllm-gr.daily.v1"
SUMMARY_NAME = "vllm-gr-summary.json"
DISPLAY_START_DATE = "2026-09-01"
PHASE_VERSION_PREFERENCE = (
    "vllm-gr-canonical-beam-search-v1-e2e-v1",
    "vllm-gr-native-phases-v1",
    "vllm-gr-canonical-e2e-v1",
    "vllm-gr-serving-internal-v3",
    "vllm-gr-serving-token1-v2",
)
ONLINE_LATENCY_METRICS = ("ttft", "tpot", "itl", "e2el")
OFFLINE_LATENCY_METRICS = ("e2el", "e2el_hit")
PERCENTILES = ("mean", "p50", "p90", "p95", "p99")
# Scenarios the daily matrix no longer produces. Their historical summaries stay
# on disk, but a single orphan point is not a trend, so stop rendering them.
RETIRED_SCENARIOS = frozenset({"bw512-in1024"})

CORE_METRICS = (
    {"key": "e2el", "label": "E2E miss", "unit": "ms", "measurement": "canonical"},
    {"key": "e2el_hit", "label": "E2E hit", "unit": "ms", "measurement": "canonical"},
    {"key": "prefill_miss", "label": "Prefill miss", "unit": "ms", "measurement": "stage"},
    {"key": "prefill_hit", "label": "Prefill hit", "unit": "ms", "measurement": "stage"},
    {"key": "prefill", "label": "Avg Prefill", "unit": "ms", "measurement": "stage"},
    {"key": "decode", "label": "Decode total (token 1+)", "unit": "ms", "measurement": "stage"},
)

DIAGNOSTIC_METRICS = (
    {"key": "prefill_gpu_compute", "label": "Prefill GPU compute", "unit": "ms", "measurement": "gpu-compute"},
    {"key": "decode_gpu_compute", "label": "Decode GPU compute total", "unit": "ms", "measurement": "gpu-compute"},
    {"key": "prefill_device_idle", "label": "Prefill device wait", "unit": "ms", "measurement": "gpu-wait"},
    {"key": "decode_device_idle", "label": "Decode device wait", "unit": "ms", "measurement": "gpu-wait"},
    {"key": "prefill_output_consumed", "label": "Prefill output consumed", "unit": "ms", "measurement": "diagnostic"},
    {"key": "prefill_dispatch", "label": "Prefill dispatch wait", "unit": "ms", "measurement": "diagnostic"},
    {"key": "prefill_cpu_lead", "label": "Prefill / Decode CPU lead", "unit": "ms", "measurement": "diagnostic"},
    {"key": "host_overhead", "label": "Host overhead outside both stages", "unit": "ms", "measurement": "diagnostic"},
    {"key": "sort", "label": "Final sort", "unit": "ms", "measurement": "diagnostic"},
    {"key": "entry_preprocess", "label": "Prompt preprocess", "unit": "ms", "measurement": "diagnostic"},
    {"key": "beam_setup", "label": "Beam setup / pre_calc", "unit": "ms", "measurement": "diagnostic"},
    {"key": "llm_engine_prefill", "label": "llm_engine.step() prefill", "unit": "ms", "measurement": "diagnostic"},
    {"key": "llm_engine_decode", "label": "llm_engine.step() decode", "unit": "ms", "measurement": "diagnostic"},
    {"key": "engine_collect_decode", "label": "Decode output collection", "unit": "ms", "measurement": "diagnostic"},
    {"key": "cpu_finalize_logprobs", "label": "Final logprobs rebuild", "unit": "ms", "measurement": "diagnostic"},
    {"key": "cpu_finalize_detokenize", "label": "Final detokenize", "unit": "ms", "measurement": "diagnostic"},
)


def load_json(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("top-level JSON value must be an object")
    return data


def require_object(data: dict[str, Any], key: str) -> dict[str, Any]:
    value = data.get(key)
    if not isinstance(value, dict):
        raise ValueError(f"{key} must be an object")
    return value


def require_nonempty_string(data: dict[str, Any], key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} must be a non-empty string")
    return value


def validate_iso_date(value: str, key: str) -> None:
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"{key} must be an ISO date") from exc


def validate_iso_datetime(value: str, key: str) -> None:
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{key} must be an ISO date-time") from exc


def validate_latency_distribution(name: str, values: dict[str, Any]) -> None:
    for percentile in PERCENTILES:
        value = values.get(percentile)
        if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
            raise ValueError(f"results.latency_ms.{name}.{percentile} must be non-negative")
    ordered = [float(values[key]) for key in ("p50", "p90", "p95", "p99")]
    if ordered != sorted(ordered):
        raise ValueError(f"results.latency_ms.{name} percentiles must be monotonic")
    if values.get("unit", "ms") != "ms":
        raise ValueError(f"results.latency_ms.{name}.unit must be ms")


def validate_summary(data: dict[str, Any]) -> None:
    if data.get("schema_version") != SCHEMA_VERSION:
        raise ValueError(f"schema_version must be {SCHEMA_VERSION!r}")

    run = require_object(data, "run")
    run_id = require_nonempty_string(run, "id")
    run_date = require_nonempty_string(run, "date")
    validate_iso_date(run_date, "run.date")
    validate_iso_datetime(require_nonempty_string(run, "started_at"), "run.started_at")
    validate_iso_datetime(require_nonempty_string(run, "finished_at"), "run.finished_at")
    if run.get("status") not in {"success", "failed", "invalid"}:
        raise ValueError("run.status must be success, failed, or invalid")
    for flag in ("trend_eligible", "baseline_eligible"):
        if not isinstance(run.get(flag), bool):
            raise ValueError(f"run.{flag} must be boolean")
    reasons = run.get("qualification_reasons")
    if not isinstance(reasons, list) or any(not isinstance(item, str) for item in reasons):
        raise ValueError("run.qualification_reasons must be a string array")

    source = require_object(data, "source")
    require_nonempty_string(source, "repository")
    require_nonempty_string(source, "git_sha")
    if "git_subject" in source:
        require_nonempty_string(source, "git_subject")
    change = source.get("change_since_previous")
    if change is not None:
        if not isinstance(change, dict):
            raise ValueError("source.change_since_previous must be an object or null")
        pull_requests = change.get("pull_requests", [])
        if not isinstance(pull_requests, list) or any(not isinstance(item, dict) for item in pull_requests):
            raise ValueError("source.change_since_previous.pull_requests must be an object array")
    environment = require_object(data, "environment")
    require_nonempty_string(environment, "host")
    require_nonempty_string(environment, "hardware")
    model = require_object(data, "model")
    require_nonempty_string(model, "id")

    dataset = require_object(data, "dataset")
    kind = dataset.get("kind")
    if kind not in {"real", "synthetic-smoke", "synthetic-control"}:
        raise ValueError("dataset.kind is invalid")
    if not isinstance(dataset.get("representative"), bool):
        raise ValueError("dataset.representative must be boolean")
    selection = require_object(dataset, "selection")
    sample_count = selection.get("sample_count")
    if not isinstance(sample_count, int) or isinstance(sample_count, bool) or sample_count < 1:
        raise ValueError("dataset.selection.sample_count must be a positive integer")

    scenario = require_object(data, "scenario")
    num_prompts = scenario.get("num_prompts")
    if not isinstance(num_prompts, int) or isinstance(num_prompts, bool) or num_prompts < 1:
        raise ValueError("scenario.num_prompts must be a positive integer")
    if sample_count != num_prompts:
        raise ValueError("dataset sample_count must equal scenario num_prompts")
    if "key" in scenario:
        require_nonempty_string(scenario, "key")
    if "input_tokens_target" in scenario:
        value = scenario["input_tokens_target"]
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise ValueError("scenario.input_tokens_target must be a positive integer")
    for key in ("beam_api", "beam_execution_mode", "pipeline_version"):
        if key in scenario:
            require_nonempty_string(scenario, key)

    results = require_object(data, "results")
    requests = require_object(results, "requests")
    completed = requests.get("completed")
    failed = requests.get("failed")
    if not all(isinstance(value, int) and not isinstance(value, bool) and value >= 0 for value in (completed, failed)):
        raise ValueError("request counts must be non-negative integers")
    if completed + failed != num_prompts:
        raise ValueError("completed + failed must equal scenario num_prompts")

    latency = require_object(results, "latency_ms")
    execution_mode = scenario.get("execution_mode", "online")
    latency_metrics = OFFLINE_LATENCY_METRICS if execution_mode == "offline" else ONLINE_LATENCY_METRICS
    for name in latency_metrics:
        validate_latency_distribution(name, require_object(latency, name))
    if execution_mode == "offline" and "decode" in latency:
        validate_latency_distribution("decode", require_object(latency, "decode"))
    for name in (
        "prefill",
        "prefill_miss",
        "prefill_hit",
        "decode",
        "sort",
        "total_beam",
        "prefill_output_consumed",
        "prefill_output_consumed_miss",
        "prefill_output_consumed_hit",
        "prefill_dispatch",
        "prefill_dispatch_miss",
        "prefill_dispatch_hit",
        "prefill_cpu_lead",
        "prefill_cpu_lead_miss",
        "prefill_cpu_lead_hit",
        "host_overhead",
        "host_overhead_miss",
        "host_overhead_hit",
        "prefill_gpu_compute",
        "prefill_gpu_compute_miss",
        "prefill_gpu_compute_hit",
        "decode_gpu_compute",
        "decode_gpu_compute_miss",
        "decode_gpu_compute_hit",
        "prefill_device_idle",
        "prefill_device_idle_miss",
        "prefill_device_idle_hit",
        "decode_device_idle",
        "decode_device_idle_miss",
        "decode_device_idle_hit",
        "engine_prefill_miss",
        "engine_prefill_hit",
        "engine_decode_miss",
        "engine_decode_hit",
        "beam_entry_overhead_miss",
        "beam_entry_overhead_hit",
        "cpu_prepare",
        "cpu_decision",
        "cpu_eos",
        "cpu_topk",
        "cpu_materialize",
    ):
        if execution_mode == "offline" and name in latency:
            validate_latency_distribution(name, require_object(latency, name))
    diagnostic = results.get("diagnostic")
    if diagnostic is not None:
        if not isinstance(diagnostic, dict):
            raise ValueError("results.diagnostic must be an object or null")
        if diagnostic.get("trend_eligible") is not False:
            raise ValueError("results.diagnostic.trend_eligible must be false")
        diagnostic_count = diagnostic.get("num_prompts")
        if not isinstance(diagnostic_count, int) or diagnostic_count < 1:
            raise ValueError("results.diagnostic.num_prompts must be a positive integer")
        diagnostic_latency = require_object(diagnostic, "latency_ms")
        for name, values in diagnostic_latency.items():
            if not isinstance(values, dict):
                raise ValueError(f"results.diagnostic.latency_ms.{name} must be an object")
            validate_latency_distribution(name, values)
    if "cache" in results:
        prefix = require_object(require_object(results, "cache"), "prefix")
        hit_rate = prefix.get("hit_rate_percent")
        if not isinstance(hit_rate, (int, float)) or isinstance(hit_rate, bool) or not 0 <= hit_rate <= 100:
            raise ValueError("results.cache.prefix.hit_rate_percent must be between 0 and 100")

    samples = require_object(results, "samples")
    sample_metrics = ("e2el_ms", "e2el_hit_ms", "input_tokens", "output_tokens") if execution_mode == "offline" else ("ttft_ms", "input_tokens", "output_tokens")
    for name in sample_metrics:
        values = samples.get(name)
        if not isinstance(values, list):
            raise ValueError(f"results.samples.{name} must be an array")
        if values and len(values) != completed:
            raise ValueError(f"results.samples.{name} must contain one value per completed request")

    baseline_eligible = run["baseline_eligible"]
    trend_eligible = run["trend_eligible"]
    if baseline_eligible:
        if run["status"] != "success" or failed:
            raise ValueError("baseline-eligible run must succeed with zero failed requests")
        if kind != "real" or dataset.get("representative") is not True:
            raise ValueError("baseline-eligible run must use a representative real dataset")
        if not dataset.get("sha256") or not selection.get("sample_ids_sha256"):
            raise ValueError("baseline-eligible run must pin dataset and sample IDs with SHA-256")
        if scenario.get("warmup_requests", 0) < 1:
            raise ValueError("baseline-eligible run must include warmup requests")
    if trend_eligible and not baseline_eligible:
        raise ValueError("trend-eligible run must also be baseline eligible")

    if not run_id.startswith("p0-") and run_date not in run_id:
        # Daily production IDs should be human-auditable. Calibration IDs are exempt.
        raise ValueError("production run id must include run.date")


def discover_runs(source: Path) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for path in sorted(source.rglob(SUMMARY_NAME)):
        data = load_json(path)
        try:
            validate_summary(data)
        except ValueError as exc:
            raise ValueError(f"{path}: {exc}") from exc
        scenario = data["scenario"]
        benchmark_args = scenario.get("benchmark_args", {})
        phase_version = benchmark_args.get("phase_definition", {}).get("version")
        scenario_key = scenario.get("key", f"beam{scenario.get('n', 'unknown')}-legacy")
        if (
            data["run"]["date"] >= DISPLAY_START_DATE
            and scenario.get("execution_mode") == "offline"
            and scenario_key not in RETIRED_SCENARIOS
        ):
            candidates.append({"path": path.as_posix(), "summary": data, "phase_version": phase_version})
    # Keep the historical series across methodology revisions, but select only
    # the newest available phase for each natural-day/scenario cell. The UI
    # breaks the line where the measurement version changes.
    phase_rank = {version: index for index, version in enumerate(PHASE_VERSION_PREFERENCE)}
    selected: dict[tuple[str, str, str], dict[str, Any]] = {}
    for item in candidates:
        summary = item["summary"]
        scenario = summary["scenario"]
        scenario_key = scenario.get("key", f"beam{scenario.get('n', 'unknown')}-legacy")
        pipeline = scenario.get("pipeline_version", "legacy-beam-search")
        key = (summary["run"]["date"], scenario_key, pipeline)
        previous = selected.get(key)
        item_rank = phase_rank.get(item["phase_version"], len(phase_rank))
        previous_rank = (
            phase_rank.get(previous["phase_version"], len(phase_rank))
            if previous is not None
            else len(phase_rank) + 1
        )
        if (
            previous is None
            or item_rank < previous_rank
            or (
                item_rank == previous_rank
                and summary["run"]["started_at"] > previous["summary"]["run"]["started_at"]
            )
        ):
            selected[key] = item
    runs = list(selected.values())
    runs.sort(key=lambda item: (item["summary"]["run"]["date"], item["summary"]["run"]["started_at"]))
    return runs


def active_diagnostic_metric_keys(summaries: list[dict[str, Any]]) -> set[str]:
    """Diagnostic stage keys still produced by the newest daily snapshot.

    The probe set evolves between releases. A key that survives only in older
    snapshots would render as a three-day orphan next to today's cards, so it
    is dropped once the matrix stops emitting it.
    """
    latest = max((item["run"]["date"] for item in summaries), default=None)
    if latest is None:
        return set()
    keys: set[str] = set()
    for item in summaries:
        if item["run"]["date"] != latest:
            continue
        latency = (item.get("results", {}).get("diagnostic") or {}).get("latency_ms")
        if isinstance(latency, dict):
            keys.update(latency)
    return keys


def build_payload(runs: list[dict[str, Any]]) -> dict[str, Any]:
    summaries = [item["summary"] for item in runs]
    phase_versions = sorted({item["phase_version"] for item in runs if item["phase_version"]})
    active_version = phase_versions[0] if len(phase_versions) == 1 else "mixed"
    scenarios = {}
    for item in summaries:
        scenario = item["scenario"]
        key = scenario.get("key", f"beam{scenario.get('n', 'unknown')}-legacy")
        scenarios[key] = {
            "key": key,
            "label": scenario["name"],
            "beam_width": scenario.get("n"),
            "input_tokens": scenario.get("input_tokens_target"),
        }
    core_metrics = list(CORE_METRICS)
    active_diagnostic = active_diagnostic_metric_keys(summaries)
    diagnostic_metrics = [metric for metric in DIAGNOSTIC_METRICS if metric["key"] in active_diagnostic]
    return {
        "schema_version": "vllm-gr.dashboard.v1",
        "generated_from": SUMMARY_NAME,
        "runs": summaries,
        "gpu": "unrecorded",
        "phase_version": active_version,
        "scenarios": sorted(scenarios.values(), key=lambda item: (item["beam_width"] or 0, item["input_tokens"] or 0)),
        "core_metrics": core_metrics,
        "diagnostic_metrics": diagnostic_metrics,
        "metrics": core_metrics + diagnostic_metrics,
        "percentiles": list(PERCENTILES),
    }


def dashboard_markdown(has_runs: bool) -> str:
    intro = (
        "Daily offline single-batch performance. The dashboard shows only "
        "offline results captured on or after 2026-09-01 and preserves established-metric "
        "history across measurement revisions. Dashed trend segments indicate measurement or sampling changes."
    )
    if not has_runs:
        return f"# vllm-gr Performance\n\n{intro}\n\nNo vllm-gr artifacts found.\n"
    return "\n".join(
        [
            "# vllm-gr Performance",
            "",
            intro,
            "",
            '<div class="vgr-dashboard" id="vgr-dashboard">',
            '  <div class="vgr-toolbar">',
            '    <div class="vgr-control"><label for="vgr-scenario">Scenario</label><select id="vgr-scenario"></select></div>',
            '    <div class="vgr-control"><label for="vgr-percentile">Statistic</label><select id="vgr-percentile"></select></div>',
            '    <p class="vgr-count" id="vgr-count"></p>',
            "  </div>",
            '  <div id="vgr-status"></div>',
            '  <section class="vgr-latest" id="vgr-latest"></section>',
            '  <section class="vgr-section"><div class="vgr-section-head"><div><p class="vgr-kicker">Daily delivery</p><h2>PRs included in this daily snapshot</h2></div><p>Metric movement is shown only in the daily trend charts below.</p></div><div id="vgr-daily-change"></div></section>',
            '  <section class="vgr-section"><div class="vgr-section-head"><div><p class="vgr-kicker">Reproducibility</p><h2>Current configuration</h2></div><p>Exact parameters for the selected run.</p></div><div id="vgr-config"></div></section>',
            '  <section class="vgr-section">',
            '    <div class="vgr-section-head"><div><p class="vgr-kicker">Selected run · GPU timeline</p><h2 id="vgr-miss-hit-title">Prefill and Decode Miss/Hit breakdown</h2></div><p>The selected statistic is shown for the diagnostic sample; device wait equals device span minus measured GPU compute.</p></div>',
            '    <div id="vgr-miss-hit-breakdown" aria-live="polite"></div>',
            "  </section>",
            '  <section class="vgr-section">',
            '    <div class="vgr-section-head"><div><p class="vgr-kicker">Established metrics</p><h2 id="vgr-core-trends-title">Core performance history</h2></div><p>Solid line: same measurement version. Dashed line: measurement or sampling changed; compare with caution.</p></div>',
            '    <div class="vgr-trend-grid" id="vgr-core-trend-grid" aria-live="polite"></div>',
            "  </section>",
            '  <section class="vgr-section">',
            '    <div class="vgr-section-head"><div><p class="vgr-kicker">GPU computation first</p><h2 id="vgr-diagnostic-trends-title">Compute and wait history</h2></div><p>GPU compute and device-wait metrics appear first; all earlier diagnostics remain available after them.</p></div>',
            '    <div class="vgr-trend-grid" id="vgr-diagnostic-trend-grid" aria-live="polite"></div>',
            "  </section>",
            '  <section class="vgr-section"><div class="vgr-section-head"><div><p class="vgr-kicker">Measurement</p><h2>Latency profile</h2></div></div><div id="vgr-latency-grid"></div></section>',
            '  <section class="vgr-section"><div class="vgr-section-head"><div><p class="vgr-kicker">Beam execution</p><h2>Prefill & Decode</h2></div><p>CUDA device-timeline phases on the engine compute stream for the selected run.</p></div><div id="vgr-beam-profile"></div></section>',
            '  <section class="vgr-section">',
            '    <div class="vgr-section-head"><div><p class="vgr-kicker">Stage execution</p><h2>Additive stage decomposition · mean only</h2></div><p>Arithmetic means over the diagnostic sample: the decomposition is additive for means, so the Statistic selector above does not apply to this section.</p></div>',
            '    <div id="vgr-stage-figure" aria-live="polite"></div>',
            "  </section>",
            '  <section class="vgr-section"><div class="vgr-section-head"><div><p class="vgr-kicker">Methodology</p><h2>Metric definitions</h2></div><p>How to read and compare the values.</p></div><div class="vgr-methodology"><p><strong>Canonical Offline E2E hit/miss</strong>: the official daily trend. Each measured pair is <code>reset → measured miss → identical measured hit</code>. The timed call uses one outer monotonic clock and a final CUDA completion fence; output materialization happens after the clock stops.</p><p><strong>GPU compute</strong>: V1 Prefill GPU compute sums CUDA intervals covering model-forward/compute-logits and sample/beam initialization. Decode GPU compute sums each Decode graph replay and sample/beam-advance interval. These events exclude dispatch, Decode CPU preparation, and inter-stage queue gaps. They bracket GPU enqueue clusters and are a low-overhead daily approximation; exact kernel-busy time still requires CUPTI or Nsight.</p><p><strong>Prefill / Decode device spans</strong>: collected in a smaller post-canonical pass after every official E2E sample has finished, with Worker probes disabled. Legacy points use the legacy token-loop host boundary. V1 spans are recorded on the single FIFO compute stream. They include GPU compute plus device idle caused by CPU launch or queue waits. The spans are additive and sum with <strong>Host overhead</strong> back to diagnostic E2E. <strong>Prefill/Decode device wait</strong> is the corresponding span minus GPU compute. <strong>Prefill dispatch wait</strong> is submit to Prefill stage entry, <strong>Prefill / Decode CPU lead</strong> is how far CPU Decode preparation leads GPU Prefill completion, and <strong>Prefill output consumed</strong> marks the later EngineCore-visible boundary.</p><p><strong>Pipeline series</strong>: legacy <code>beam_search</code> and V1 <code>beam_search_v1</code> remain on the same metric chart with distinct lines and markers. Lines never connect different pipeline versions. The V1 series starts at <code>2026-09-18</code>: the pipeline was measured on 2026-09-17 before its stage definitions were settled, so those points are omitted from both trend charts rather than drawn as a revision. The legacy series keeps its full history.</p><p><strong>Average (Mean)</strong>: arithmetic mean over the relevant canonical or stage observations. The measurement source is shown beside every chart and comparison card.</p><p><strong>Daily trend and PRs</strong>: each date runs only that day\'s latest <code>decode_graph</code> snapshot; the system does not rerun the preceding SHA. Trend points show PRs merged since the preceding published daily snapshot.</p></div></section>',
            '  <section class="vgr-section"><div class="vgr-section-head"><div><p class="vgr-kicker">Evidence</p><h2>Run history</h2></div><p>Select a run to inspect its configuration.</p></div><div id="vgr-run-history"></div></section>',
            "</div>",
            "",
        ]
    )


def write_dashboard(source: Path, output: Path) -> None:
    runs = discover_runs(source)
    payload = build_payload(runs)
    output.mkdir(parents=True, exist_ok=True)
    (output / "vllm-gr-dashboard-data.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    (output / "vllm-gr.md").write_text(dashboard_markdown(bool(runs)), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path("runs"))
    parser.add_argument("--output", type=Path, default=Path("docs"))
    args = parser.parse_args()
    write_dashboard(args.source, args.output)


if __name__ == "__main__":
    main()
