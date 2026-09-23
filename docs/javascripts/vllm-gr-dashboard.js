(function () {
  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function number(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  function fmt(value, digits) {
    const numeric = number(value);
    if (numeric === null) return "N/A";
    if (digits !== undefined) return numeric.toFixed(digits);
    if (Math.abs(numeric) >= 1000) return numeric.toFixed(0);
    if (Math.abs(numeric) >= 100) return numeric.toFixed(1);
    if (Math.abs(numeric) >= 10) return numeric.toFixed(2);
    return numeric.toFixed(3);
  }

  function metricValue(run, metric, percentile, measurement = "canonical") {
    const diagnosticMeasurement = !["canonical", "stage"].includes(measurement);
    const latency = diagnosticMeasurement
      ? (run.results?.diagnostic?.latency_ms || run.results?.latency_ms)
      : run.results?.latency_ms;
    const fallback = measurement === "canonical" || measurement === "stage"
      ? run.results?.diagnostic?.latency_ms?.[metric]?.[percentile]
      : null;
    return number(latency?.[metric]?.[percentile] ?? fallback);
  }

  function renderMissHitBreakdown(root, run, percentile) {
    if (!run) {
      root.innerHTML = '<div class="vgr-empty">No run selected.</div>';
      return;
    }
    const latency = run.results?.diagnostic?.latency_ms || {};
    const rows = [
      ["Prefill device span", "prefill_miss", "prefill_hit", "stage"],
      ["Prefill GPU compute", "prefill_gpu_compute_miss", "prefill_gpu_compute_hit", "gpu-compute"],
      ["Prefill device wait", "prefill_device_idle_miss", "prefill_device_idle_hit", "gpu-wait"],
      ["Decode device span", "decode_miss", "decode_hit", "stage"],
      ["Decode GPU compute", "decode_gpu_compute_miss", "decode_gpu_compute_hit", "gpu-compute"],
      ["Decode device wait", "decode_device_idle_miss", "decode_device_idle_hit", "gpu-wait"],
      ["Prefill output consumed", "prefill_output_consumed_miss", "prefill_output_consumed_hit", "diagnostic"],
      ["Host overhead", "host_overhead_miss", "host_overhead_hit", "diagnostic"],
    ];
    const hasGpuBreakdown = [
      "prefill_gpu_compute_miss", "prefill_gpu_compute_hit",
      "decode_gpu_compute_miss", "decode_gpu_compute_hit",
    ].some((key) => latency[key]);
    if (!hasGpuBreakdown) {
      root.innerHTML = '<div class="vgr-empty">This run predates the GPU-compute-v5 Miss/Hit breakdown. Select a newer run after the next formal benchmark.</div>';
      return;
    }
    const cell = (key) => {
      const value = number(latency[key]?.[percentile]);
      return value === null ? '<span class="vgr-na">N/A</span>' : `${escapeHtml(fmt(value))} <small>ms</small>`;
    };
    root.innerHTML = `
      <div class="vgr-breakdown-wrap">
        <table class="vgr-breakdown-table">
          <thead><tr><th scope="col">Metric</th><th scope="col">Miss</th><th scope="col">Hit</th></tr></thead>
          <tbody>${rows.map(([label, missKey, hitKey, kind]) => `
            <tr class="is-${escapeHtml(kind)}"><th scope="row">${escapeHtml(label)}<small>${escapeHtml(kind)}</small></th><td>${cell(missKey)}</td><td>${cell(hitKey)}</td></tr>
          `).join("")}</tbody>
        </table>
      </div>
      <p class="vgr-breakdown-note">${escapeHtml(percentile.toUpperCase())} · diagnostic sample only · ${escapeHtml(run.run?.date || "unknown date")} · ${escapeHtml(diagnosticPhaseVersion(run))}</p>
    `;
  }

  function scenarioKey(run) {
    return run.scenario?.key || `beam${run.scenario?.n ?? "unknown"}-legacy`;
  }

  function sourceLabel(run) {
    const prs = run.source?.change_since_previous?.pull_requests;
    if (Array.isArray(prs) && prs.length) {
      return prs.map((pr) => `PR #${pr.number} ${pr.title}`).join(" · ");
    }
    const subject = run.source?.git_subject;
    if (subject) return subject;
    return `${run.source?.branch || "source"} daily snapshot · ${run.run?.date || "unknown date"}`;
  }

  function metricSeriesVersion(run, measurement) {
    if (measurement !== "canonical") return diagnosticPhaseVersion(run);
    return phaseVersion(run);
  }

  function diagnosticPhaseVersion(run) {
    return run.results?.diagnostic?.phase_definition?.version || phaseVersion(run);
  }

  function pipelineKey(run) {
    return run.scenario?.pipeline_version || "legacy-beam-search";
  }

  function pipelineLabel(run) {
    return run.scenario?.beam_api === "beam_search_v1"
      ? "V1 beam_search_v1"
      : "Legacy beam_search";
  }

  // The V1 pipeline was measured on 2026-09-17 while its stage definitions were
  // still being settled. Every core metric exists on that date, so the point
  // would draw as a full series beside the 09-18 caliber and read as movement
  // that never happened. The V1 series therefore starts here; the legacy series
  // keeps its full history. Both trend grids share lineChart, so this rule
  // reaches the canonical and the diagnostic metrics alike.
  const V1_TREND_START_DATE = "2026-09-18";

  function trendSampleIsComparable(run) {
    if (run.scenario?.beam_api !== "beam_search_v1") return true;
    return (run.run?.date || "") >= V1_TREND_START_DATE;
  }

  function kpi(label, value, suffix, hint) {
    return `<div class="vgr-kpi"><p>${escapeHtml(label)}</p><strong>${escapeHtml(value)}${suffix ? ` <small>${escapeHtml(suffix)}</small>` : ""}</strong>${hint ? `<span>${escapeHtml(hint)}</span>` : ""}</div>`;
  }

  function renderLatest(root, run) {
    if (!run) {
      root.innerHTML = '<div class="vgr-empty">No runs match the current filters.</div>';
      return;
    }
    const mode = run.scenario.execution_mode || "offline";
    const latency = run.results.latency_ms || {};
    const diagnostic = run.results.diagnostic?.latency_ms || latency;
    const ttft = latency.ttft;
    const e2el = latency.e2el;
    const requests = run.results.requests;
    const primaryKpis = [
      ["Avg Offline E2E miss", e2el, "direct GRLLM call after cache reset"],
      ["Avg Offline E2E hit", latency.e2el_hit, "same prompt immediately after the measured miss"],
      [latency.prefill ? "Avg Prefill" : "Diagnostic Prefill", latency.prefill || diagnostic.prefill, latency.prefill ? "native phase timestamps" : "legacy diagnostic sample"],
      [latency.decode ? "Avg Decode" : "Diagnostic Decode", latency.decode || diagnostic.decode, latency.decode ? "native phase timestamps; includes finalization" : "legacy diagnostic sample"],
    ].map(([label, value, hint]) => kpi(label, fmt(value?.mean), "ms", value ? `P50 ${fmt(value.p50)} ms · P90 ${fmt(value.p90)} ms · ${hint}` : hint)).join("");
    root.innerHTML = `
      <div class="vgr-hero-copy">
        <div class="vgr-hero-label"><span>${escapeHtml(run.run.date)} · ${escapeHtml(run.environment?.hardware || "GPU unrecorded")}</span></div>
        <h2>${escapeHtml(run.scenario.name)}</h2>
        <p>${escapeHtml(run.model.id)} · ${escapeHtml(run.dataset.name)}</p>
        <div class="vgr-tags">
          <span>${escapeHtml(run.dataset.kind)}</span>
          <span>${escapeHtml(mode)} mode</span>
          <span>concurrency ${escapeHtml(run.scenario.max_concurrency)}</span>
          <span>beam n=${escapeHtml(run.scenario.n)}</span>
          <span>input ${escapeHtml(run.scenario.input_tokens_target ?? "dataset")} tokens</span>
          <span>${escapeHtml(requests.completed)} passed / ${escapeHtml(requests.failed)} failed</span>
        </div>
      </div>
      <div class="vgr-kpi-grid">
        ${primaryKpis}
      </div>
    `;
  }

  function renderConfig(root, run) {
    if (!run) {
      root.innerHTML = '<div class="vgr-empty">No run selected.</div>';
      return;
    }
    const scenario = run.scenario || {};
    const args = scenario.server_args || {};
    const benchmark = scenario.benchmark_args || {};
    const rows = [
      ["Execution", scenario.execution_mode || "online"],
      ["Beam API", scenario.beam_api || "beam_search"],
      ["Pipeline", scenario.pipeline_version || "legacy-beam-search"],
      ["GPU", run.environment?.hardware || "unrecorded"],
      ["Source change", sourceLabel(run)],
      ["Exact revision", run.source.git_sha],
      ["Model", run.model.id],
      ["Dataset", `${run.dataset.name} / ${run.dataset.task}`],
      ["Beam width", scenario.n],
      ["Input length", scenario.input_tokens_target == null ? "not recorded" : `${scenario.input_tokens_target} tokens`],
      ["Output length", benchmark.max_tokens == null ? "model config" : `${benchmark.max_tokens} tokens per returned beam`],
      ["Measured / warmup", `${scenario.num_prompts} / ${scenario.warmup_requests}`],
      ["Concurrency", scenario.max_concurrency],
      ["Attention backend", args.attention_backend || "server default"],
      ["Beam decode graph", args.beam_graph_enabled === true ? `enabled · exact width ${args.beam_max_width}` : "disabled / eager"],
      ["Max sequences", args.max_num_seqs],
      ["Max batched tokens", args.max_num_batched_tokens],
      ["Cache protocol", benchmark.cache_protocol || "reset once after warmup"],
      ["Phase definition", benchmark.phase_definition?.version || "legacy"],
      ["Measurement", benchmark.measurement_mode || "legacy"],
      ["Canonical instrumentation", benchmark.instrumentation?.canonical || "legacy measurement"],
      ["Diagnostic requests", benchmark.diagnostic_prompts],
      ["GPU", run.environment?.gpu ? `${run.environment.gpu.name} · ${run.environment.gpu.memory_mib} MiB` : undefined],
      ["Scheduling", args.scheduling],
      ["Decode execution", args.decode_execution],
      ["Resident request", args.resident_request],
      ["Engine batch capacity", args.engine_batch_capacity],
      ["Benchmark vocab size", args.benchmark_vocab_size],
      ["Decode steps", benchmark.decode_steps],
      ["Output mode", benchmark.output_mode],
      ["Profile directory", args.profile_dir],
    ].filter(([, value]) => value !== undefined && value !== null);
    root.innerHTML = `<dl class="vgr-config-grid">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
  }

  function yDomain(values) {
    if (!values.length) return { min: 0, max: 1 };
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      const pad = Math.abs(min) * 0.15 || 1;
      min = Math.max(0, min - pad);
      max += pad;
    } else {
      const pad = (max - min) * 0.12;
      min = Math.max(0, min - pad);
      max += pad;
    }
    return { min, max };
  }

  function lineChart(runs, metric, percentile, meta) {
    const points = runs
      .filter(trendSampleIsComparable)
      .map((run) => ({ run, value: metricValue(run, metric, percentile, meta.measurement) }))
      .filter((point) => point.value !== null);
    if (!points.length) return '<div class="vgr-empty">No values are available for this selection.</div>';

    const width = 1040;
    const height = 360;
    const left = 72;
    const right = 28;
    const top = 28;
    const bottom = 88;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const domain = yDomain(points.map((point) => point.value));
    const dates = [...new Set(points.map((point) => point.run.run.date))].sort();
    const dateIndex = new Map(dates.map((value, index) => [value, index]));
    const x = (date) => {
      const index = dateIndex.get(date) || 0;
      return left + (dates.length === 1 ? plotW / 2 : (index / (dates.length - 1)) * plotW);
    };
    const y = (value) => top + (1 - (value - domain.min) / (domain.max - domain.min)) * plotH;
    const grid = [];
    for (let tick = 0; tick <= 4; tick += 1) {
      const value = domain.max - ((domain.max - domain.min) * tick) / 4;
      const yy = top + (plotH * tick) / 4;
      grid.push(`<line x1="${left}" y1="${yy}" x2="${width - right}" y2="${yy}" class="vgr-grid-line"/>`);
      grid.push(`<text x="${left - 12}" y="${yy + 4}" text-anchor="end" class="vgr-axis-label">${escapeHtml(fmt(value))}</text>`);
    }
    const grouped = new Map();
    points.forEach((point) => {
      const key = pipelineKey(point.run);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(point);
    });
    const series = [...grouped.entries()].sort(([leftKey], [rightKey]) => {
      const leftLegacy = leftKey === "legacy-beam-search" ? 0 : 1;
      const rightLegacy = rightKey === "legacy-beam-search" ? 0 : 1;
      return leftLegacy - rightLegacy || leftKey.localeCompare(rightKey);
    });
    const segments = series.map(([, seriesPoints], seriesIndex) => {
      seriesPoints.sort((a, b) => a.run.run.date.localeCompare(b.run.run.date));
      return seriesPoints.slice(1).map((point, index) => {
        const previous = seriesPoints[index];
        const changed = metricSeriesVersion(previous.run, meta.measurement) !== metricSeriesVersion(point.run, meta.measurement);
        return `<line x1="${x(previous.run.run.date)}" y1="${y(previous.value)}" x2="${x(point.run.run.date)}" y2="${y(point.value)}" class="vgr-trend-line is-series-${seriesIndex}"${changed ? ' stroke-dasharray="6 5"' : ""}><title>${changed ? "Measurement version changed within this pipeline" : pipelineLabel(point.run)}</title></line>`;
      }).join("");
    }).join("");
    const marks = series.map(([, seriesPoints], seriesIndex) => seriesPoints.map((point) => {
      const xx = x(point.run.run.date);
      const yy = y(point.value);
      const title = `${point.run.run.date} · ${pipelineLabel(point.run)} · ${sourceLabel(point.run)} · ${metricSeriesVersion(point.run, meta.measurement)} · ${fmt(point.value)} ${meta.unit}`;
      const marker = seriesIndex === 0
        ? `<circle cx="${xx}" cy="${yy}" r="6"><title>${escapeHtml(title)}</title></circle>`
        : `<rect x="${xx - 5.5}" y="${yy - 5.5}" width="11" height="11" transform="rotate(45 ${xx} ${yy})"><title>${escapeHtml(title)}</title></rect>`;
      return `<g class="vgr-point is-series-${seriesIndex}">${marker}<text x="${xx}" y="${yy - 13}" text-anchor="middle" class="vgr-value-label">${escapeHtml(fmt(point.value))}</text></g>`;
    }).join("")).join("");
    const xLabels = dates.map((date) => `<text x="${x(date)}" y="${height - 58}" text-anchor="middle" class="vgr-axis-label">${escapeHtml(date.slice(5))}</text>`).join("");
    const legend = series.map(([, seriesPoints], index) => `<g transform="translate(${left + index * 190}, ${height - 34})" class="vgr-series-legend is-series-${index}"><line x1="0" y1="0" x2="24" y2="0" class="vgr-trend-line is-series-${index}"/><text x="31" y="4" class="vgr-axis-label">${escapeHtml(pipelineLabel(seriesPoints[0].run))}</text></g>`).join("");
    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(meta.label)} ${escapeHtml(percentile)} daily trend"><text x="18" y="${top + plotH / 2}" transform="rotate(-90 18 ${top + plotH / 2})" text-anchor="middle" class="vgr-axis-title">${escapeHtml(meta.label)} (${escapeHtml(meta.unit)})</text>${grid.join("")}${segments}${marks}${xLabels}${legend}<text x="${left + plotW / 2}" y="${height - 4}" text-anchor="middle" class="vgr-axis-title">Run date</text></svg>`;
  }

  function renderTrendGrid(root, runs, percentile, metrics) {
    root.innerHTML = metrics.map((meta) => `
      <article class="vgr-trend-card">
        <div class="vgr-trend-card-head"><strong>${escapeHtml(meta.label)}</strong><span>${escapeHtml(meta.measurement || "canonical")} · ${escapeHtml(percentile.toUpperCase())}</span></div>
        <div class="vgr-chart">${lineChart(runs, meta.key, percentile, meta)}</div>
      </article>
    `).join("");
  }

  function renderLatencyGrid(root, run) {
    if (!run) {
      root.innerHTML = '<div class="vgr-empty">No run selected.</div>';
      return;
    }
    const labels = { e2el: "E2E miss", e2el_hit: "E2E hit", prefill: "Avg Prefill", prefill_miss: "Prefill miss", prefill_hit: "Prefill hit", decode: "Decode total (token 1+)", prefill_gpu_compute: "Prefill GPU compute", decode_gpu_compute: "Decode GPU compute total", prefill_device_idle: "Prefill device wait", decode_device_idle: "Decode device wait", prefill_output_consumed: "Prefill output consumed", prefill_dispatch: "Prefill dispatch wait", prefill_cpu_lead: "Prefill / Decode CPU lead", host_overhead: "Host overhead outside both stages", llm_engine_decode: "llm_engine.step() decode", engine_collect_decode: "Decode output collection", entry_preprocess: "Prompt preprocess", beam_setup: "Beam setup / pre_calc", cpu_finalize_detokenize: "Final detokenize" };
    const canonical = run.results.latency_ms || {};
    const diagnostic = run.results.diagnostic?.latency_ms || canonical;
    const available = ["e2el", "e2el_hit"].filter((key) => canonical[key]).map((key) => [key, canonical[key], "canonical"])
      .concat(["prefill_miss", "prefill_hit", "prefill", "decode"].filter((key) => canonical[key] || diagnostic[key]).map((key) => [key, canonical[key] || diagnostic[key], "stage"]))
      .concat(["prefill_gpu_compute", "decode_gpu_compute", "prefill_device_idle", "decode_device_idle", "prefill_output_consumed", "prefill_dispatch", "prefill_cpu_lead", "host_overhead", "entry_preprocess", "beam_setup", "llm_engine_decode", "engine_collect_decode", "cpu_finalize_detokenize"].filter((key) => diagnostic[key]).map((key) => [key, diagnostic[key], key.includes("gpu_compute") ? "gpu-compute" : key.includes("device_idle") ? "gpu-wait" : "diagnostic"]));
    root.innerHTML = `<div class="vgr-latency-cards">${available.map(([key, value, measurement]) => {
      return `<article class="vgr-latency-card"><div><strong>${escapeHtml(labels[key] || key)}</strong><small>${escapeHtml(measurement)}</small></div><dl><dt>Mean</dt><dd>${fmt(value.mean)} ms</dd><dt>P50</dt><dd>${fmt(value.p50)} ms</dd><dt>P90</dt><dd>${fmt(value.p90)} ms</dd><dt>P95</dt><dd>${fmt(value.p95)} ms</dd><dt>P99</dt><dd>${fmt(value.p99)} ms</dd></dl></article>`;
    }).join("")}</div>`;
  }

  function renderBeamProfile(root, run) {
    if (!run) {
      root.innerHTML = '<div class="vgr-empty">No run selected.</div>';
      return;
    }
    const latency = run.results.diagnostic?.latency_ms || run.results.latency_ms || {};
    const states = [
        ["Cold / miss average", latency.prefill_miss, latency.decode, latency.e2el],
        ["Warm / hit average", latency.prefill_hit, latency.decode, latency.e2el_hit],
      ];
      root.innerHTML = `<div class="vgr-beam-profile-grid">${states.map(([label, prefill, decode, e2e]) => {
        const parts = [["Avg Prefill", prefill?.mean, "is-prefill"], ["Avg Decode common", decode?.mean, "is-decode"]];
        const total = parts.reduce((sum, part) => sum + (number(part[1]) || 0), 0);
        const segments = parts.map(([partLabel, value, className]) => `<span class="${className}" style="width:${total ? 100 * value / total : 0}%" title="${escapeHtml(partLabel)}: ${fmt(value)} ms"></span>`).join("");
        return `<article class="vgr-profile-card"><div class="vgr-profile-title"><strong>${escapeHtml(label)}</strong><span>${fmt(e2e?.mean)} ms Avg E2E</span></div><div class="vgr-stack-bar">${segments}</div><div class="vgr-profile-legend">${parts.map(([partLabel, value, className]) => `<span><i class="${className}"></i>${escapeHtml(partLabel)} <strong>${fmt(value)} ms</strong></span>`).join("")}</div></article>`;
      }).join("")}</div>`;
  }

  // ------------------------------------------------------------ stage figure --
  //
  // Port of the standalone render_stage_figure.py prototype: an additive
  // decomposition of the v5 diagnostic sample for the selected run.
  //
  // All three figures share ONE px/ms derived from the domain below, so a bar of
  // equal length means an equal duration in every one of them, including across
  // the miss and hit panels. Only the arithmetic mean is drawn -- the
  // decomposition is additive for means but not for percentiles (the p50 of a
  // sum is not the sum of the p50s), so the Statistic selector deliberately does
  // not reach this section.
  //
  // Nothing here touches the DOM after render: every label is a string built up
  // front and assigned in a single innerHTML, which is what makes an interactive
  // zoom layer structurally impossible to reintroduce. The only non-ASCII
  // characters in this block are the "≈" and "→" glyphs in bar labels and anchor
  // prose.
  const STAGE_STATES = ["miss", "hit"];
  const STAGE_E2E_KEY = { miss: "e2el", hit: "e2el_hit" };
  // Every key the figure reads. Expanded per state so the completeness guard
  // cannot drift from the readers below.
  const STAGE_BASE_KEYS = [
    "prefill", "prefill_gpu_compute", "prefill_device_idle",
    "decode", "decode_gpu_compute", "decode_device_idle",
    "prefill_dispatch", "prefill_cpu_lead", "prefill_output_consumed", "host_overhead",
  ];
  // Hue carries the stage (teal prefill, indigo decode, amber host) and lightness
  // carries compute versus idle. One class per slot serves the SVG mark, the
  // legend swatch and the label ink at once: "fill" is ignored on an <i> and
  // "background" on a <rect>, and the descendant text rule turns the fill into
  // the right ink.
  const STAGE_BAND_A_SEGMENTS = [
    ["prefill-gpu", "Prefill GPU compute", "prefill_gpu_compute"],
    ["prefill-idle", "Prefill device idle", "prefill_device_idle"],
    ["decode-gpu", "Decode GPU compute", "decode_gpu_compute"],
    ["decode-idle", "Decode device idle", "decode_device_idle"],
    ["host", "Host overhead", "host_overhead"],
  ];
  // (lane, row label, [bar spec]) where a bar spec is
  // (duration key, start endpoint, end endpoint, fill slot, projected?).
  const STAGE_LAYER_ROWS = [
    ["host", "dispatch", [["prefill_dispatch", "dispatch_end", 0, "host", false]]],
    ["host", "look-ahead", [["prefill_cpu_lead", "lead_start", "prefill", "host", false]]],
    ["host", "output", [["prefill_output_consumed", "dispatch_end", "consumed", "host", false]]],
    ["host", "overhead", [
      ["host_overhead_head", "dispatch_end", 0, "host", true],
      ["host_overhead_tail", "decode", "overhead_tail", "host", true],
    ]],
    ["device", "prefill", [
      ["prefill_gpu_compute", 0, "prefill_gpu_compute", "prefill-gpu", false],
      ["prefill_device_idle", "prefill_gpu_compute", "prefill", "prefill-idle", false],
    ]],
    ["device", "decode", [
      ["decode_gpu_compute", "prefill", "decode_gpu_compute", "decode-gpu", false],
      ["decode_device_idle", "decode_gpu_compute", "decode", "decode-idle", false],
    ]],
  ];
  // (metric key, lane, miss cell key, hit cell key). The two cell keys are
  // optional and default to `${key}_miss` / `${key}_hit`; only the E2E row needs
  // them, because the summariser's historical naming has no `e2el_miss` -- the
  // miss-side key is the bare `e2el` and only the hit side is suffixed.
  const STAGE_ANCHOR_ROWS = [
    // The container first: E2E brackets every span below it, and it is the one row
    // whose counterpart in the core trends is measured on a different sample.
    ["e2el", "both", "e2el", "e2el_hit"],
    ["prefill_dispatch", "host"], ["prefill_cpu_lead", "host"],
    ["prefill_output_consumed", "host"], ["host_overhead", "host"],
    ["prefill", "device"], ["prefill_gpu_compute", "device"],
    ["prefill_device_idle", "device"], ["decode", "device"],
    ["decode_gpu_compute", "device"], ["decode_device_idle", "device"],
  ];
  // Where each span starts and stops. File line numbers are deliberately absent:
  // they drift every time the benchmark script is edited, and a stale anchor in a
  // published page is worse than no anchor.
  const STAGE_ANCHOR_TEXT = {
    e2el: [
      "request_started, immediately before the instrumented Beam API call",
      "request_finished, immediately after that call returns",
      "host wall over the whole request: frontend dispatch, Prefill, Decode and terminal collection. This row is the diagnostic sample, so prefill + decode + host_overhead closes to it exactly; the E2E trend draws the canonical pass instead",
    ],
    prefill_dispatch: [
      "beam_started, after the synchronize inside timed_submit",
      "prefill_worker_started, the PREFILL branch of timed_execute",
      "GPUBeamStageRunner.execute entry",
    ],
    prefill_cpu_lead: [
      "first_decode_started, the first DECODE execute entry on the host clock",
      "prefill_gpu_ready = prefill_worker_started + prefill_ms",
      "first DECODE execute entry",
    ],
    prefill_output_consumed: [
      "beam_started",
      "prefill_output_consumed, when AsyncGPUBeamOutput.get_output returns",
      "AsyncGPUBeamOutput.get_output waits on the produced_ready event",
    ],
    host_overhead: [
      "e2e - prefill - decode",
      "same, not an independent event",
      "head = entering submit_once plus dispatch; tail = decode device end → wait_final returns",
    ],
    prefill: [
      "prefill_stage_start_event",
      "prefill_end_event, after the output-producing PREFILL sample",
      "execute → sample; output-producing is decided by metadata.produces_output",
    ],
    prefill_gpu_compute: [
      "prefill_model_start_event + prefill_sample_pair[0]",
      "prefill_execute_end_event + prefill_sample_pair[1]",
      "model forward (graph replay) + compute_logits + sample",
    ],
    prefill_device_idle: [
      "residual prefill_ms - prefill_gpu_compute_ms",
      "same, not an independent event",
      "host gap between the execute entry's native input preparation and the graph replay",
    ],
    decode: [
      "decode_start_event, recorded at the first DECODE execute entry",
      "decode_end_event, after the last decode sample",
      "execute → sample, decode branch",
    ],
    decode_gpu_compute: [
      "start of each decode_compute_pairs segment",
      "end of each such segment",
      "BeamDecodeGraph.replay, or the eager _forward",
    ],
    decode_device_idle: [
      "residual decode_ms - decode_gpu_compute_ms",
      "same, not an independent event",
      "dominated by compute_logits outside the replay event pairs: real computation, not idle",
    ],
  };
  // The head/tail split of host_overhead needs the offset of beam_started from
  // request_started, which is never instrumented, so the measured dispatch span
  // is substituted for the head and the remainder becomes the tail.
  const STAGE_BAR_ALIASES = {
    host_overhead_head: "head ≈dispatch",
    host_overhead_tail: "tail ≈wrap-up",
  };
  const STAGE_NOTES = {
    bandA: "Each row is additive: prefill_gpu_compute + prefill_device_idle + decode_gpu_compute + decode_device_idle + host_overhead == e2e. Both states are asserted before drawing and the section is suppressed when a residual is non-zero. The pale segments are the part of the same device span where the GPU is not running a kernel, which means it is waiting on the host, not idle GPU capacity.",
    sharedAxis: "Both lanes share one horizontal axis: device-time offset from the PREFILL execute entry (0), the instant prefill_stage_start_event is recorded. Span start and end are directly comparable: the two device spans are contiguous on a single FIFO compute stream, prefill_dispatch ends at 0 by construction, and prefill_cpu_lead ends at prefill exactly. Miss and hit share one px/ms, so equal bar length means equal duration.",
    deviceIdle: "*_device_idle is measured with CUDA events on the device clock, so it can only live on the device lane; but that stretch of GPU inactivity is caused by the CPU, which has not finished feeding kernels. Read a pale device segment against the host bar that spans it: prefill_cpu_lead or prefill_output_consumed.",
    projected: "Semi-transparent bars are projections, not measurements: host_overhead is a head plus a tail, and splitting it needs the offset of beam_started from request_started, the cost of entering submit_once, which is never instrumented. The measured dispatch span is substituted for the head and the remainder becomes the tail, so when host_overhead <= prefill_dispatch the two drawn pieces no longer sum to host_overhead, hence the ≈. Start and end anchors for every bar are in the anchor table below.",
    anchors: "The six core metric trends at the top of the page carry the same keys as these rows: e2el and e2el_hit are the first row, prefill_miss, prefill_hit and prefill the Prefill row, and decode the Decode row. Miss mean and Hit mean are always the two per-cache-state distributions, while the prefill and decode trends each draw one pooled series over both states, so such a trend value sits between its row's two columns rather than on either. E2E is the one row whose trend reads a different sample: the trend's e2el and e2el_hit are canonical, and every other core key reads the diagnostic distribution this table is built from.",
  };
  const STAGE_GEOM = {
    width: 1280, labelW: 130, right: 26,
    bandATop: 52, bandARowH: 46, bandAGap: 34,
    rowH: 34, gap: 10, groupGap: 24, titleH: 30,
    barInlineMin: 46, inlineMin: 96, leaderMin: 10,
    residualLimit: 1e-6,
  };

  function stageMean(latency, key) {
    return number(latency?.[key]?.mean);
  }

  function stageRequiredKeys() {
    const keys = ["e2el", "e2el_hit"];
    STAGE_STATES.forEach((state) => {
      STAGE_BASE_KEYS.forEach((base) => keys.push(`${base}_${state}`));
    });
    return keys;
  }

  function stageComplete(latency) {
    if (!latency) return false;
    return stageRequiredKeys().every((key) => stageMean(latency, key) !== null);
  }

  // Largest residual over the three additivity identities, in ms. The first two
  // are tautological upstream (device idle is produced as a residual), so the
  // load-bearing check is prefill + decode + host_overhead == e2e. Returns
  // Infinity when a value is missing, which also fails the gate.
  function stageResidual(latency) {
    let worst = 0;
    for (const state of STAGE_STATES) {
      const values = {};
      for (const base of ["prefill", "prefill_gpu_compute", "prefill_device_idle",
        "decode", "decode_gpu_compute", "decode_device_idle", "host_overhead"]) {
        const value = stageMean(latency, `${base}_${state}`);
        if (value === null) return Infinity;
        values[base] = value;
      }
      const e2e = stageMean(latency, STAGE_E2E_KEY[state]);
      if (e2e === null) return Infinity;
      worst = Math.max(
        worst,
        Math.abs(values.prefill - (values.prefill_gpu_compute + values.prefill_device_idle)),
        Math.abs(values.decode - (values.decode_gpu_compute + values.decode_device_idle)),
        Math.abs(e2e - (values.prefill + values.decode + values.host_overhead)),
      );
    }
    return worst;
  }

  // One domain for every figure, and therefore one px/ms. The e2e term is
  // load-bearing: Band A stacks from axis 0 out to E2E while the device timeline
  // only reaches prefill + decode + tail, so without it the miss row overruns the
  // viewBox by min(host_overhead, dispatch) * scale px and its last segment is
  // clipped away.
  function stageFrame(latency) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const state of STAGE_STATES) {
      const dispatch = stageMean(latency, `prefill_dispatch_${state}`);
      const prefill = stageMean(latency, `prefill_${state}`);
      const decode = stageMean(latency, `decode_${state}`);
      const overhead = stageMean(latency, `host_overhead_${state}`);
      const e2e = stageMean(latency, STAGE_E2E_KEY[state]);
      lo = Math.min(lo, -dispatch);
      hi = Math.max(hi, prefill + decode + Math.max(overhead - dispatch, 0), e2e);
    }
    const scale = (STAGE_GEOM.width - STAGE_GEOM.labelW - STAGE_GEOM.right) / (hi - lo);
    return { lo, hi, scale, x: (value) => STAGE_GEOM.labelW + (value - lo) * scale };
  }

  function stageBandARows(latency) {
    return STAGE_STATES.map((state) => ({
      state,
      e2e: stageMean(latency, STAGE_E2E_KEY[state]),
      segments: STAGE_BAND_A_SEGMENTS.map(([slot, label, base]) => ({
        slot, label, value: stageMean(latency, `${base}_${state}`),
      })),
    }));
  }

  function renderStageBandA(rows, frame) {
    const geom = STAGE_GEOM;
    const height = geom.bandATop + rows.length * (geom.bandARowH + geom.bandAGap) + 30;
    const parts = [`<svg viewBox="0 0 ${geom.width} ${height}" role="img" aria-label="Additive device-time decomposition of end-to-end latency by request state">`];
    for (let tick = 0; tick <= Math.floor(frame.hi) + 10; tick += 10) {
      if (tick > frame.hi) continue;
      parts.push(`<line x1="${frame.x(tick).toFixed(2)}" y1="${geom.bandATop - 14}" x2="${frame.x(tick).toFixed(2)}" y2="${height - 30}" class="vgr-grid-line"/>`);
      parts.push(`<text x="${frame.x(tick).toFixed(2)}" y="${geom.bandATop - 20}" class="vgr-axis-label">${tick} ms</text>`);
    }
    parts.push(`<line x1="${frame.x(0).toFixed(2)}" y1="${geom.bandATop - 14}" x2="${frame.x(0).toFixed(2)}" y2="${height - 30}" class="vgr-stage-zero"/>`);
    rows.forEach((row, index) => {
      const y = geom.bandATop + index * (geom.bandARowH + geom.bandAGap);
      parts.push(`<text x="0" y="${y + 18}" class="vgr-stage-strong">${escapeHtml(row.state.toUpperCase())}</text>`);
      parts.push(`<text x="0" y="${y + 36}" class="vgr-axis-label">E2E ${escapeHtml(fmt(row.e2e, 2))} ms</text>`);
      let cursor = frame.x(0);
      row.segments.forEach((segment) => {
        const width = segment.value * frame.scale;
        parts.push(`<g class="vgr-stage-fill-${segment.slot}">`);
        parts.push(`<rect x="${cursor.toFixed(2)}" y="${y}" width="${Math.max(width, 0.6).toFixed(2)}" height="${geom.bandARowH}" rx="2"><title>${escapeHtml(`${segment.label}: ${fmt(segment.value)} ms`)}</title></rect>`);
        if (width >= geom.barInlineMin) {
          parts.push(`<text x="${(cursor + width / 2).toFixed(2)}" y="${y + 21}" text-anchor="middle" class="vgr-stage-value">${escapeHtml(fmt(segment.value, 2))}</text>`);
          parts.push(`<text x="${(cursor + width / 2).toFixed(2)}" y="${y + 36}" text-anchor="middle" class="vgr-stage-name">${escapeHtml(segment.label.split(" ")[0])}</text>`);
        }
        parts.push("</g>");
        if (width < geom.barInlineMin && width >= geom.leaderMin) {
          // Too narrow for an inline label; hang a leader tag under the bar so a
          // sub-2 ms sliver is still readable.
          parts.push(`<line x1="${(cursor + width / 2).toFixed(2)}" y1="${y + geom.bandARowH}" x2="${(cursor + width / 2).toFixed(2)}" y2="${y + geom.bandARowH + 8}" class="vgr-stage-leader"/>`);
          parts.push(`<text x="${(cursor + width / 2).toFixed(2)}" y="${y + geom.bandARowH + 19}" text-anchor="middle" class="vgr-stage-leader">${escapeHtml(fmt(segment.value, 2))}</text>`);
        }
        cursor += width;
      });
    });
    parts.push("</svg>");
    return parts.join("");
  }

  function stageEndpoints(latency, state) {
    const value = (base) => stageMean(latency, `${base}_${state}`);
    const dispatch = value("prefill_dispatch");
    const prefill = value("prefill");
    const decode = value("decode");
    const overhead = value("host_overhead");
    const tail = Math.max(overhead - dispatch, 0);
    const prefillGpu = value("prefill_gpu_compute");
    const decodeGpu = value("decode_gpu_compute");
    return {
      ends: {
        dispatch_end: -dispatch,
        lead_start: prefill - value("prefill_cpu_lead"),
        consumed: -dispatch + value("prefill_output_consumed"),
        prefill_gpu_compute: prefillGpu,
        prefill,
        decode_gpu_compute: prefill + decodeGpu,
        decode: prefill + decode,
        overhead_tail: prefill + decode + tail,
      },
      durations: {
        prefill_dispatch: dispatch,
        prefill_cpu_lead: value("prefill_cpu_lead"),
        prefill_output_consumed: value("prefill_output_consumed"),
        host_overhead_head: dispatch,
        host_overhead_tail: tail,
        prefill_gpu_compute: prefillGpu,
        prefill_device_idle: value("prefill_device_idle"),
        decode_gpu_compute: decodeGpu,
        decode_device_idle: value("decode_device_idle"),
      },
    };
  }

  function stageSpan(endpoints, start, end) {
    const resolve = (endpoint) => (typeof endpoint === "string" ? endpoints.ends[endpoint] : endpoint);
    const first = resolve(start);
    const second = resolve(end);
    return second < first ? [second, first] : [first, second];
  }

  // A row that hangs a leader label underneath needs extra room, or the label
  // lands on the next group header. The decision is taken over BOTH states so the
  // miss and hit panels keep identical row heights and stay comparable row by
  // row, which matters most on the look-ahead row, where the two states differ
  // by more than 5x.
  function stagePanelExtra(endpoints, scale) {
    const extra = {};
    STAGE_LAYER_ROWS.forEach(([, name, specs]) => {
      const thinnest = Math.min(...STAGE_STATES.map((state) => Math.min(...specs.map(([, start, end]) => {
        const [a, b] = stageSpan(endpoints[state], start, end);
        return (b - a) * scale;
      }))));
      extra[name] = thinnest < STAGE_GEOM.inlineMin ? 18 : 0;
    });
    return extra;
  }

  function renderStagePanel(latency, state, frame) {
    const geom = STAGE_GEOM;
    const points = {};
    STAGE_STATES.forEach((item) => { points[item] = stageEndpoints(latency, item); });
    const endpoints = points[state];
    const extra = stagePanelExtra(points, frame.scale);
    const height = geom.titleH + geom.groupGap + 30
      + STAGE_LAYER_ROWS.reduce((sum, [, name]) => sum + geom.rowH + geom.gap + extra[name], 0);
    const plotW = geom.width - geom.labelW - geom.right;
    const parts = [`<svg viewBox="0 0 ${geom.width} ${height}" role="img" aria-label="${escapeHtml(state)} host and device timeline on one shared axis">`];
    parts.push(`<rect x="${geom.labelW}" y="${geom.titleH - 16}" width="${plotW}" height="${height - geom.titleH - 2}" class="vgr-stage-panel" rx="4"/>`);
    parts.push(`<text x="0" y="${geom.titleH - 20}" class="vgr-stage-strong">${escapeHtml(state.toUpperCase())}</text>`);
    // The same ruler as Band A, so a vertical line means the same instant in all
    // three figures.
    for (let tick = 0; tick <= Math.floor(frame.hi) + 10; tick += 10) {
      if (tick > frame.hi) continue;
      parts.push(`<line x1="${frame.x(tick).toFixed(2)}" y1="${geom.titleH - 16}" x2="${frame.x(tick).toFixed(2)}" y2="${height - 20}" class="vgr-grid-line"/>`);
      parts.push(`<text x="${frame.x(tick).toFixed(2)}" y="${geom.titleH - 20}" class="vgr-axis-label">${tick} ms</text>`);
    }
    parts.push(`<line x1="${frame.x(0).toFixed(2)}" y1="${geom.titleH - 16}" x2="${frame.x(0).toFixed(2)}" y2="${height - 20}" class="vgr-stage-zero"/>`);
    parts.push(`<text x="${frame.x(0).toFixed(2)}" y="${height - 7}" text-anchor="middle" class="vgr-axis-label">PREFILL execute entry (0)</text>`);
    let y = geom.titleH;
    STAGE_LAYER_ROWS.forEach(([lane, name, specs]) => {
      if (name === "dispatch") {
        parts.push(`<text x="0" y="${y - 8}" class="vgr-stage-lane-group">HOST clock · perf_counter_ns</text>`);
      }
      if (lane === "device" && name === "prefill") {
        y += geom.groupGap;
        parts.push(`<text x="0" y="${y - 8}" class="vgr-stage-lane-group">DEVICE clock · single FIFO CUDA stream</text>`);
      }
      parts.push(`<text x="0" y="${y + 21}" class="vgr-stage-lane">${escapeHtml(name)}</text>`);
      specs.forEach(([key, start, end, slot, projected]) => {
        const [a, b] = stageSpan(endpoints, start, end);
        const x0 = frame.x(a);
        const width = Math.max((b - a) * frame.scale, 1);
        const label = STAGE_BAR_ALIASES[key] || key;
        const caption = `${fmt(endpoints.durations[key], 2)} ms`;
        parts.push(`<g class="vgr-stage-fill-${slot}">`);
        parts.push(`<rect x="${x0.toFixed(2)}" y="${y}" width="${width.toFixed(2)}" height="${geom.rowH}" rx="2"${projected ? ' class="vgr-stage-projected"' : ""}><title>${escapeHtml(`${label} = ${caption}`)}</title></rect>`);
        if (width >= geom.inlineMin) {
          parts.push(`<text x="${(x0 + width / 2).toFixed(2)}" y="${y + 15}" text-anchor="middle" class="vgr-stage-name">${escapeHtml(label)}</text>`);
          parts.push(`<text x="${(x0 + width / 2).toFixed(2)}" y="${y + 28}" text-anchor="middle" class="vgr-stage-value">${escapeHtml(caption)}</text>`);
        }
        parts.push("</g>");
        if (width < geom.inlineMin) {
          parts.push(`<line x1="${(x0 + width / 2).toFixed(2)}" y1="${y + geom.rowH}" x2="${(x0 + width / 2).toFixed(2)}" y2="${y + geom.rowH + 6}" class="vgr-stage-leader"/>`);
          parts.push(`<text x="${(x0 + width / 2).toFixed(2)}" y="${y + geom.rowH + 16}" text-anchor="middle" class="vgr-stage-leader">${escapeHtml(`${label} ${caption}`)}</text>`);
        }
      });
      y += geom.rowH + geom.gap + extra[name];
    });
    parts.push("</svg>");
    return parts.join("");
  }

  // The note closing the anchor table also names the canonical E2E for this run, so
  // a reader can reconcile the table with the E2E trend without leaving the page.
  // The numbers are appended only when both passes carry a value; a run without a
  // canonical latency block still gets the prose.
  function stageAnchorNote(latency, run) {
    const canonical = (key) => number(run?.results?.latency_ms?.[key]?.mean);
    const canonicalMiss = canonical("e2el");
    const canonicalHit = canonical("e2el_hit");
    const tableMiss = stageMean(latency, "e2el");
    const tableHit = stageMean(latency, "e2el_hit");
    if (
      canonicalMiss === null || canonicalHit === null
      || tableMiss === null || tableHit === null
    ) {
      return STAGE_NOTES.anchors;
    }
    // Deliberately not "the gap is the probe cost": the diagnostic pass runs
    // faster on one cache state and slower on the other, so the difference is
    // sampling plus probe cost rather than a one-way bias. Claiming otherwise
    // would read as a calibrated offset and invite subtracting it.
    return `${STAGE_NOTES.anchors} On this run the canonical means are ${fmt(canonicalMiss, 3)} ms miss and ${fmt(canonicalHit, 3)} ms hit, against ${fmt(tableMiss, 3)} / ${fmt(tableHit, 3)} above; they are two separate passes, so they need not agree to the last digit.`;
  }

  function renderStageAnchorTable(latency, run) {
    const rows = STAGE_ANCHOR_ROWS.map(([key, lane, missKey, hitKey]) => {
      const [start, end, engine] = STAGE_ANCHOR_TEXT[key];
      // Three decimals here, two on the bars: the table is the value of record,
      // while the inline label has to stay readable inside a 30 px segment.
      const cell = (cellKey) => {
        const value = stageMean(latency, cellKey);
        return escapeHtml(value === null ? "N/A" : fmt(value, 3));
      };
      return `<tr><th scope="row"><code>${escapeHtml(key)}</code></th><td>${escapeHtml(lane)}</td><td>${cell(missKey || `${key}_miss`)}</td><td>${cell(hitKey || `${key}_hit`)}</td><td><code>${escapeHtml(start)}</code></td><td><code>${escapeHtml(end)}</code></td><td>${escapeHtml(engine)}</td></tr>`;
    }).join("");
    return `
      <h3>Start and end anchors</h3>
      <div class="vgr-breakdown-wrap vgr-stage-anchors">
        <table class="vgr-breakdown-table">
          <thead><tr><th scope="col">Metric</th><th scope="col">Lane</th><th scope="col">Miss mean</th><th scope="col">Hit mean</th><th scope="col">Start anchor</th><th scope="col">End anchor</th><th scope="col">Engine-side semantics</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="vgr-breakdown-note">${escapeHtml(stageAnchorNote(latency, run))}</p>
    `;
  }

  function renderStageFigure(root, run) {
    // The other renderers assume their container exists; this one does not, so an
    // omitted section degrades to a missing figure instead of throwing inside
    // refresh() and taking renderRunHistory and every later change handler down
    // with it.
    if (!root) return;
    if (!run) {
      root.innerHTML = '<div class="vgr-empty">No run selected.</div>';
      return;
    }
    const latency = run.results?.diagnostic?.latency_ms;
    if (!latency) {
      root.innerHTML = '<div class="vgr-empty">No diagnostic stage sample was recorded for this run, so the v5 stage decomposition cannot be drawn. Select a run measured on the GPU-compute-v5 caliber.</div>';
      return;
    }
    if (!stageComplete(latency)) {
      root.innerHTML = '<div class="vgr-empty">This run predates the GPU-compute-v5 stage caliber: prefill, decode, host overhead and the device split are not instrumented together, so the stage figure is not drawn.</div>';
      return;
    }
    const residual = stageResidual(latency);
    if (!(residual < STAGE_GEOM.residualLimit)) {
      root.innerHTML = `<div class="vgr-empty">This run fails the v5 additivity gate (residual ${escapeHtml(fmt(residual * 1000, 3))} us): prefill + decode + host overhead no longer closes to E2E, so the stage figure is not drawn.</div>`;
      return;
    }
    const frame = stageFrame(latency);
    const legend = STAGE_BAND_A_SEGMENTS
      .map(([slot, label]) => `<span><i class="vgr-stage-fill-${slot}"></i>${escapeHtml(label)}</span>`)
      .join("");
    root.innerHTML = `
      <div class="vgr-stage">
        <div class="vgr-profile-legend">${legend}</div>
        <div class="vgr-chart">${renderStageBandA(stageBandARows(latency), frame)}</div>
        <p class="vgr-breakdown-note">${escapeHtml(STAGE_NOTES.bandA)}</p>
        <div class="vgr-chart">${renderStagePanel(latency, "miss", frame)}</div>
        <div class="vgr-chart">${renderStagePanel(latency, "hit", frame)}</div>
        <p class="vgr-breakdown-note">${escapeHtml(STAGE_NOTES.sharedAxis)}</p>
        <p class="vgr-breakdown-note">${escapeHtml(STAGE_NOTES.deviceIdle)}</p>
        <p class="vgr-breakdown-note">${escapeHtml(STAGE_NOTES.projected)}</p>
        ${renderStageAnchorTable(latency, run)}
      </div>
    `;
  }

  function phaseVersion(run) {
    return run.scenario?.benchmark_args?.phase_definition?.version || "legacy";
  }

  function renderDailyChange(root, run) {
    if (!run) {
      root.innerHTML = '<div class="vgr-empty">No run selected.</div>';
      return;
    }
    const change = run.source?.change_since_previous || {};
    const prs = Array.isArray(change.pull_requests) ? change.pull_requests : [];
    const prHtml = prs.length
      ? prs.map((pr) => `<a class="vgr-pr-chip" href="${escapeHtml(pr.url)}" target="_blank" rel="noopener">PR #${escapeHtml(pr.number)} · ${escapeHtml(pr.title)}</a>`).join("")
      : '<span class="vgr-muted">No merged PR was detected for this daily snapshot.</span>';
    root.innerHTML = `<div class="vgr-pr-list">${prHtml}</div>`;
  }

  function renderRunHistory(root, runs, selectedId, onSelect) {
    if (!runs.length) {
      root.innerHTML = '<div class="vgr-empty">No runs match the current filters.</div>';
      return;
    }
    root.innerHTML = `<div class="vgr-run-list">${runs.slice().reverse().map((run) => {
      const active = run.run.id === selectedId ? " is-active" : "";
      return `<button type="button" class="vgr-run-row${active}" data-run-id="${escapeHtml(run.run.id)}"><span class="vgr-run-date">${escapeHtml(run.run.date)}</span><span class="vgr-run-main"><strong>${escapeHtml(run.scenario.name)}</strong><small>${escapeHtml(sourceLabel(run))} · ${escapeHtml(run.dataset.kind)} · ${escapeHtml(run.environment?.hardware || "GPU unrecorded")}</small></span><span class="vgr-run-result">${escapeHtml(run.results.requests.completed)}/${escapeHtml(run.scenario.num_prompts)}</span></button>`;
    }).join("")}</div>`;
    root.querySelectorAll(".vgr-run-row").forEach((button) => {
      button.addEventListener("click", () => onSelect(button.getAttribute("data-run-id")));
    });
  }

  function initDashboard(data) {
    const root = document.getElementById("vgr-dashboard");
    if (!root) return;
    const scenarioSelect = document.getElementById("vgr-scenario");
    const percentileSelect = document.getElementById("vgr-percentile");
    const count = document.getElementById("vgr-count");
    const latest = document.getElementById("vgr-latest");
    const dailyChange = document.getElementById("vgr-daily-change");
    const coreTrendGrid = document.getElementById("vgr-core-trend-grid");
    const diagnosticTrendGrid = document.getElementById("vgr-diagnostic-trend-grid");
    const coreTrendsTitle = document.getElementById("vgr-core-trends-title");
    const diagnosticTrendsTitle = document.getElementById("vgr-diagnostic-trends-title");
    const missHitTitle = document.getElementById("vgr-miss-hit-title");
    const missHitBreakdown = document.getElementById("vgr-miss-hit-breakdown");
    const latencyGrid = document.getElementById("vgr-latency-grid");
    const beamProfile = document.getElementById("vgr-beam-profile");
    const stageFigure = document.getElementById("vgr-stage-figure");
    const config = document.getElementById("vgr-config");
    const history = document.getElementById("vgr-run-history");
    let selectedId = data.runs.length ? data.runs[data.runs.length - 1].run.id : null;

    scenarioSelect.innerHTML = ['<option value="all">All scenarios</option>', ...(data.scenarios || []).map((scenario) => `<option value="${escapeHtml(scenario.key)}">${escapeHtml(scenario.label)}</option>`)].join("");
    if ((data.scenarios || []).length) scenarioSelect.value = data.scenarios[data.scenarios.length - 1].key;
    percentileSelect.innerHTML = data.percentiles.map((item) => `<option value="${escapeHtml(item)}">${escapeHtml(item.toUpperCase())}</option>`).join("");
    percentileSelect.value = "mean";

    function filteredRuns() {
      return data.runs.filter((run) => scenarioSelect.value === "all" || scenarioKey(run) === scenarioSelect.value);
    }

    function selectedRun(runs) {
      return runs.find((run) => run.run.id === selectedId) || runs[runs.length - 1] || null;
    }

    function refresh() {
      const runs = filteredRuns();
      const selected = selectedRun(runs);
      if (selected) selectedId = selected.run.id;
      const percentile = percentileSelect.value;
      const statLabel = percentile.toUpperCase();
      count.textContent = `${runs.length} run${runs.length === 1 ? "" : "s"} shown`;
      coreTrendsTitle.textContent = `${data.core_metrics.length} core metric trends · ${statLabel}`;
      diagnosticTrendsTitle.textContent = `${data.diagnostic_metrics.length} compute and diagnostic trends · ${statLabel}`;
      missHitTitle.textContent = `Prefill and Decode Miss/Hit breakdown · ${statLabel}`;
      renderTrendGrid(coreTrendGrid, runs, percentile, data.core_metrics);
      renderTrendGrid(diagnosticTrendGrid, runs, percentile, data.diagnostic_metrics);
      renderMissHitBreakdown(missHitBreakdown, selected, percentile);
      renderLatest(latest, selected);
      renderDailyChange(dailyChange, selected);
      renderConfig(config, selected);
      renderLatencyGrid(latencyGrid, selected);
      renderBeamProfile(beamProfile, selected);
      // Deliberately not passed `percentile`: the decomposition is additive for
      // means only, so the Statistic selector must not reach this figure.
      renderStageFigure(stageFigure, selected);
      renderRunHistory(history, runs, selectedId, (runId) => {
        selectedId = runId;
        refresh();
      });
    }

    [scenarioSelect, percentileSelect].forEach((control) => control.addEventListener("change", refresh));
    refresh();
  }

  async function boot() {
    const root = document.getElementById("vgr-dashboard");
    if (!root) return;
    try {
      const url = new URL("../vllm-gr-dashboard-data.json", window.location.href);
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) throw new Error(`Failed to load vllm-gr-dashboard-data.json (${response.status})`);
      initDashboard(await response.json());
    } catch (error) {
      root.insertAdjacentHTML("afterbegin", `<div class="vgr-empty is-error">${escapeHtml(error.message)}</div>`);
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
