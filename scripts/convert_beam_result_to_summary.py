"""Convert a raw vllm-gr beam-search test result (e.g. 1.json) into the
compact ``vllm-gr-summary.json`` artifact consumed by the dashboard builder.

The raw result format (offline beam-search smoke/profile run) carries:

- top-level benchmark configuration (model, scheduling, execution_mode, ...)
- ``round_elapsed_seconds``: wall time per benchmark round
- ``elapsed_seconds``: the reported steady-state latency (last round)
- ``items``: beam-search outputs (beam_count, token_sha256, sequences with
  rank / tokens / recommendation_tokens / score)

Mapping rules (kept deliberately faithful to the source file):

- Round 0 is treated as warmup when it is a clear outlier (> 1.5x the median
  of the remaining rounds, e.g. graph capture on the first call). The
  remaining rounds become the measured samples.
- The raw file records no paired miss/hit cache protocol, so ``e2el_hit``
  mirrors ``e2el`` and both facts are recorded in ``run.notes`` /
  qualification reasons. Hit columns must not be read as an independent
  measurement.
- Beam sequences are not part of the dashboard metric schema; the original
  file is copied beside the summary as ``raw-result.json`` and registered as
  an artifact. A companion ``docs/vllm-gr-beam-results.md`` page renders the
  sequences.
- GPU / git revision are not recorded in the raw file; the summary marks them
  as unknown instead of guessing.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

SCHEMA_VERSION = "vllm-gr.daily.v1"
SUMMARY_NAME = "vllm-gr-summary.json"
TZ = timezone(timedelta(hours=8))  # runner local time (Etc/GMT-8)


def percentile(sorted_values: list[float], q: float) -> float:
    """Linear-interpolation percentile on an already sorted list."""
    if not sorted_values:
        raise ValueError("percentile of empty sample")
    if len(sorted_values) == 1:
        return float(sorted_values[0])
    idx = (len(sorted_values) - 1) * q
    lo = int(idx)
    hi = min(lo + 1, len(sorted_values) - 1)
    frac = idx - lo
    return float(sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * frac)


def distribution(samples_ms: list[float]) -> dict[str, Any]:
    ordered = sorted(samples_ms)
    mean = sum(ordered) / len(ordered)
    if len(ordered) > 1:
        variance = sum((value - mean) ** 2 for value in ordered) / (len(ordered) - 1)
        std = variance ** 0.5
    else:
        std = 0.0
    return {
        "mean": mean,
        "std": std,
        "p50": percentile(ordered, 0.50),
        "p90": percentile(ordered, 0.90),
        "p95": percentile(ordered, 0.95),
        "p99": percentile(ordered, 0.99),
        "unit": "ms",
    }


def model_id_from_path(model_path: str) -> str:
    return model_path.rstrip("/").replace("\\", "/").rsplit("/", 1)[-1] or model_path


def redact_paths(raw: dict[str, Any]) -> dict[str, Any]:
    """Strip absolute host paths before publishing (user-facing requirement).

    Model and prompt keep their basenames; profile_dir carries no useful
    basename, so it is replaced with a placeholder. Applied both to the
    generated summary and to the archived raw-result.json copy.
    """
    redacted = dict(raw)
    if redacted.get("model"):
        redacted["model"] = model_id_from_path(str(redacted["model"]))
    if redacted.get("prompt"):
        redacted["prompt"] = Path(str(redacted["prompt"])).name
    if redacted.get("profile_dir"):
        redacted["profile_dir"] = "<redacted>"
    return redacted


def convert(raw: dict[str, Any], source_path: Path, host: str, run_date: str | None) -> dict[str, Any]:
    rounds_s = [float(value) for value in raw.get("round_elapsed_seconds") or []]
    if not rounds_s:
        elapsed = raw.get("elapsed_seconds")
        if elapsed is None:
            raise ValueError("raw result has neither round_elapsed_seconds nor elapsed_seconds")
        rounds_s = [float(elapsed)]

    # Warmup detection: first round a clear outlier of the remaining ones.
    warmup_rounds = 0
    if len(rounds_s) > 1:
        rest = sorted(rounds_s[1:])
        median_rest = percentile(rest, 0.50)
        if median_rest > 0 and rounds_s[0] > 1.5 * median_rest:
            warmup_rounds = 1
    measured_s = rounds_s[warmup_rounds:]
    if not measured_s:  # degenerate single-round file
        measured_s = rounds_s
        warmup_rounds = 0
    measured_ms = [value * 1000.0 for value in measured_s]

    items = raw.get("items") or []
    first_item = items[0] if items else {}
    sequences = first_item.get("sequences") or []
    beam_width = int(raw.get("beam_width") or first_item.get("beam_count") or 0)
    max_tokens = raw.get("max_tokens")
    tokens_per_beam = len(sequences[0]["tokens"]) if sequences and max_tokens is None else max_tokens
    output_tokens_per_request = int(first_item.get("beam_count", beam_width) * (tokens_per_beam or 0))

    model_path = str(raw.get("model", ""))
    model_id = model_id_from_path(model_path)
    scheduling = raw.get("scheduling", "sync")
    execution_mode = raw.get("execution_mode", "eager")
    decode_execution = raw.get("decode_execution", "")
    batch_size = int(raw.get("active_batch_size") or 1)
    pipeline_version = "-".join(
        part for part in ("beam-search", scheduling, execution_mode, decode_execution) if part
    )
    scenario_name = f"{model_id} · beam-{beam_width} · {scheduling}-{execution_mode}"
    if decode_execution:
        scenario_name += f"-{decode_execution}"
    scenario_name += f" · offline-b{batch_size}"

    total_measured_s = sum(measured_s)
    total_output_tokens = output_tokens_per_request * len(measured_ms)
    now = datetime.now(TZ)
    date_str = run_date or now.strftime("%Y-%m-%d")
    run_id = f"beam-{beam_width}-{scheduling}-{execution_mode}-{date_str}"

    notes = [
        "Converted from a raw offline beam-search test result; not produced by the daily benchmark harness.",
        "Source file carries no timestamp, host, GPU, or git revision; the conversion date is used and hardware/revision are marked unknown.",
        f"Round 0 cold-start latency {rounds_s[0] * 1000.0:.2f} ms is excluded as warmup (graph capture / first call); "
        f"{len(measured_ms)} steady-state rounds are measured.",
        "The raw run does not implement the paired miss/hit cache protocol; e2el_hit mirrors e2el and must not be read as an independent measurement.",
        "Absolute host paths (model, prompt, profile_dir) are redacted to basenames before publishing.",
        f"Reported elapsed_seconds (last round) = {float(raw.get('elapsed_seconds', measured_s[-1])) * 1000.0:.2f} ms.",
        f"Beam search returned {len(sequences)} sequences for beam_count {first_item.get('beam_count', beam_width)}; "
        f"token_sha256 {first_item.get('token_sha256', 'n/a')} (see raw-result.json artifact).",
    ]

    started_at = now.replace(microsecond=0).isoformat()
    summary: dict[str, Any] = {
        "schema_version": SCHEMA_VERSION,
        "run": {
            "id": run_id,
            "date": date_str,
            "started_at": started_at,
            "finished_at": started_at,
            "status": "success",
            "trend_eligible": False,
            "baseline_eligible": False,
            "qualification_reasons": [
                "raw smoke/profile result: single fixed prompt, no representative dataset sample",
                "no paired miss/hit cache protocol; e2el_hit mirrors e2el",
                f"small sample: {len(measured_ms)} measured rounds after {warmup_rounds} warmup round(s)",
                "host, GPU, and git revision not recorded in the source file",
            ],
            "notes": notes,
        },
        "source": {
            "repository": "vllm-gr",
            "git_sha": "unknown",
        },
        "environment": {
            "host": host,
            "hardware": "unrecorded",
        },
        "model": {
            "id": model_id,
            "revision": None,
            "generation_config_source": "model",
            "path": model_path,
        },
        "dataset": {
            "name": Path(str(raw.get("prompt", "unknown-prompt"))).name,
            "kind": "synthetic-control",
            "representative": False,
            "task": "single-prompt",
            "path": str(raw.get("prompt", "")),
            "revision": None,
            "sha256": None,
            "selection": {
                "strategy": "single-fixed-prompt",
                "seed": None,
                "sample_count": len(measured_ms),
                "sample_ids_sha256": None,
                "shuffle": False,
            },
        },
        "scenario": {
            "key": f"beam{beam_width}-{scheduling}-{execution_mode}",
            "name": scenario_name,
            "execution_mode": "offline",
            "endpoint": "offline beam_search",
            "beam_api": "beam_search_v1",
            "beam_execution_mode": str(execution_mode),
            "pipeline_version": pipeline_version,
            "backend": "vllm-gr-offline",
            "num_prompts": len(measured_ms),
            "max_concurrency": batch_size,
            "request_rate": "sequential",
            "beam_search": True,
            "n": beam_width,
            "sweep": {
                "axis": "beam_width",
                "beam_width": beam_width,
            },
            "warmup_requests": warmup_rounds,
            "server_args": {
                "scheduling": scheduling,
                "resident_request": raw.get("resident_request"),
                "decode_execution": decode_execution,
                "execution_mode": execution_mode,
                "active_batch_size": batch_size,
                "engine_batch_capacity": raw.get("engine_batch_capacity"),
                "beam_graph_enabled": execution_mode == "graph",
                "beam_max_width": beam_width,
                "max_num_seqs": batch_size,
                "benchmark_vocab_size": raw.get("benchmark_vocab_size"),
                "profile_dir": raw.get("profile_dir"),
            },
            "benchmark_args": {
                "max_tokens": max_tokens,
                "decode_steps": raw.get("decode_steps"),
                "output_mode": raw.get("output_mode"),
                "runs": raw.get("runs"),
                "profiled_round": raw.get("profiled_round"),
                "phase_definition": {
                    "version": "vllm-gr-round-elapsed-v1",
                    "e2e": "wall-clock perf_counter around each full offline beam_search call",
                },
                "measurement_mode": "round-elapsed",
                "instrumentation": {
                    "canonical": "per-round wall clock; no CUDA completion fence recorded in the raw file",
                },
                "cache_protocol": "single prompt; round 1 cold, following rounds warm repeats",
                "metric_percentiles": [50, 90, 95, 99],
                "save_detailed": True,
            },
        },
        "results": {
            "requests": {
                "completed": len(measured_ms),
                "failed": 0,
            },
            "duration_seconds": total_measured_s,
            "tokens": {
                "input_total": 0,
                "output_total": total_output_tokens,
                "output_semantics": "beam-aggregate",
                "note": "input token count not recorded in the raw file",
            },
            "throughput": {
                "requests_per_second": len(measured_ms) / total_measured_s if total_measured_s else None,
                "output_tokens_per_second": total_output_tokens / total_measured_s if total_measured_s else None,
                "total_tokens_per_second": total_output_tokens / total_measured_s if total_measured_s else None,
            },
            "latency_ms": {
                "e2el": distribution(measured_ms),
                "e2el_hit": distribution(measured_ms),
            },
            "beam_search": {
                "requests": len(measured_ms),
                "beam_count": first_item.get("beam_count", beam_width),
                "tokens_per_beam": tokens_per_beam,
                "token_sha256": first_item.get("token_sha256"),
            },
        },
    }

    samples = {
        "e2el_ms": [round(value, 6) for value in measured_ms],
        "e2el_hit_ms": [round(value, 6) for value in measured_ms],
        "input_tokens": [],
        "output_tokens": [output_tokens_per_request] * len(measured_ms),
    }
    summary["results"]["samples"] = samples
    return summary


def write_beam_results_page(raw: dict[str, Any], summary: dict[str, Any], output: Path) -> None:
    items = raw.get("items") or []
    rows: list[str] = []
    scores: list[float] = []
    for item in items:
        for seq in item.get("sequences", []):
            scores.append(float(seq["score"]))
            tokens = ", ".join(str(token) for token in seq.get("recommendation_tokens", []))
            rows.append(
                f"| {seq['rank']} | {seq['score']:.4f} | {tokens} |"
            )
    lines = [
        "# vllm-gr Beam results",
        "",
        "Beam-search sequences for the converted run "
        f"`{summary['run']['id']}`. Scores are cumulative log-probabilities; "
        "`recommendation_tokens` strips the framing tokens from each beam.",
        "",
        f"- Model: `{summary['model']['id']}`",
        f"- Beam width: {summary['scenario']['n']} · tokens per beam: "
        f"{summary['results']['beam_search']['tokens_per_beam']}",
        f"- token_sha256: `{summary['results']['beam_search']['token_sha256']}`",
    ]
    if scores:
        ordered = sorted(scores)
        lines += [
            f"- Score range: {ordered[0]:.4f} … {ordered[-1]:.4f} "
            f"(top-1 {ordered[0]:.4f}, median {percentile(ordered, 0.5):.4f})",
        ]
    lines += [
        "",
        "## Top 32 sequences by score",
        "",
        "| Rank | Score | Recommendation tokens |",
        "|---|---|---|",
    ]
    lines += rows[:32]
    if len(rows) > 32:
        lines.append(f"| … | … | {len(rows) - 32} more sequences in raw-result.json |")
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("raw_result", type=Path, help="raw beam-search result JSON (e.g. 1.json)")
    parser.add_argument("--source", type=Path, default=Path("runs"), help="runs root directory")
    parser.add_argument("--host", default="local", help="host label for the runs directory layout")
    parser.add_argument("--date", default=None, help="run date (YYYY-MM-DD); defaults to today")
    parser.add_argument("--beam-docs", type=Path, default=Path("docs"), help="output dir for the beam results page")
    args = parser.parse_args()

    raw = json.loads(args.raw_result.read_text(encoding="utf-8"))
    summary = convert(redact_paths(raw), args.raw_result, args.host, args.date)

    run_dir = args.source / "vllm-gr" / args.host / summary["run"]["date"] / summary["run"]["id"]
    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / SUMMARY_NAME).write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    raw_copy = run_dir / "raw-result.json"
    raw_copy.write_text(json.dumps(redact_paths(raw), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    digest = hashlib.sha256(raw_copy.read_bytes()).hexdigest()
    summary["artifacts"] = [
        {
            "name": "raw result",
            "path": "raw-result.json",
            "sha256": digest,
            "bytes": raw_copy.stat().st_size,
            "retention": "runner",
        }
    ]
    (run_dir / SUMMARY_NAME).write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    write_beam_results_page(raw, summary, args.beam_docs / "vllm-gr-beam-results.md")
    print(f"wrote {run_dir / SUMMARY_NAME}")
    print(f"wrote {args.beam_docs / 'vllm-gr-beam-results.md'}")


if __name__ == "__main__":
    main()
