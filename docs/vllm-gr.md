# vllm-gr Performance

Daily offline single-batch performance. The dashboard shows only offline results captured on or after 2026-09-01 and preserves established-metric history across measurement revisions. Dashed trend segments indicate measurement or sampling changes.

<div class="vgr-dashboard" id="vgr-dashboard">
  <div class="vgr-toolbar">
    <div class="vgr-control"><label for="vgr-scenario">Scenario</label><select id="vgr-scenario"></select></div>
    <div class="vgr-control"><label for="vgr-percentile">Statistic</label><select id="vgr-percentile"></select></div>
    <p class="vgr-count" id="vgr-count"></p>
  </div>
  <div id="vgr-status"></div>
  <section class="vgr-latest" id="vgr-latest"></section>
  <section class="vgr-section"><div class="vgr-section-head"><div><p class="vgr-kicker">Daily delivery</p><h2>PRs included in this daily snapshot</h2></div><p>Metric movement is shown only in the daily trend charts below.</p></div><div id="vgr-daily-change"></div></section>
  <section class="vgr-section"><div class="vgr-section-head"><div><p class="vgr-kicker">Reproducibility</p><h2>Current configuration</h2></div><p>Exact parameters for the selected run.</p></div><div id="vgr-config"></div></section>
  <section class="vgr-section">
    <div class="vgr-section-head"><div><p class="vgr-kicker">Selected run · GPU timeline</p><h2 id="vgr-miss-hit-title">Prefill and Decode Miss/Hit breakdown</h2></div><p>The selected statistic is shown for the diagnostic sample; device wait equals device span minus measured GPU compute.</p></div>
    <div id="vgr-miss-hit-breakdown" aria-live="polite"></div>
  </section>
  <section class="vgr-section">
    <div class="vgr-section-head"><div><p class="vgr-kicker">Established metrics</p><h2 id="vgr-core-trends-title">Core performance history</h2></div><p>Solid line: same measurement version. Dashed line: measurement or sampling changed; compare with caution.</p></div>
    <div class="vgr-trend-grid" id="vgr-core-trend-grid" aria-live="polite"></div>
  </section>
  <section class="vgr-section">
    <div class="vgr-section-head"><div><p class="vgr-kicker">GPU computation first</p><h2 id="vgr-diagnostic-trends-title">Compute and wait history</h2></div><p>GPU compute and device-wait metrics appear first; all earlier diagnostics remain available after them.</p></div>
    <div class="vgr-trend-grid" id="vgr-diagnostic-trend-grid" aria-live="polite"></div>
  </section>
  <section class="vgr-section"><div class="vgr-section-head"><div><p class="vgr-kicker">Measurement</p><h2>Latency profile</h2></div></div><div id="vgr-latency-grid"></div></section>
  <section class="vgr-section"><div class="vgr-section-head"><div><p class="vgr-kicker">Beam execution</p><h2>Prefill & Decode</h2></div><p>CUDA device-timeline phases on the engine compute stream for the selected run.</p></div><div id="vgr-beam-profile"></div></section>
  <section class="vgr-section">
    <div class="vgr-section-head"><div><p class="vgr-kicker">Stage execution</p><h2>Additive stage decomposition · mean only</h2></div><p>Arithmetic means over the diagnostic sample: the decomposition is additive for means, so the Statistic selector above does not apply to this section.</p></div>
    <div id="vgr-stage-figure" aria-live="polite"></div>
  </section>
  <section class="vgr-section"><div class="vgr-section-head"><div><p class="vgr-kicker">Methodology</p><h2>Metric definitions</h2></div><p>How to read and compare the values.</p></div><div class="vgr-methodology"><p><strong>Canonical Offline E2E hit/miss</strong>: the official daily trend. Each measured pair is <code>reset → measured miss → identical measured hit</code>. The timed call uses one outer monotonic clock and a final CUDA completion fence; output materialization happens after the clock stops.</p><p><strong>GPU compute</strong>: V1 Prefill GPU compute sums CUDA intervals covering model-forward/compute-logits and sample/beam initialization. Decode GPU compute sums each Decode graph replay and sample/beam-advance interval. These events exclude dispatch, Decode CPU preparation, and inter-stage queue gaps. They bracket GPU enqueue clusters and are a low-overhead daily approximation; exact kernel-busy time still requires CUPTI or Nsight.</p><p><strong>Prefill / Decode device spans</strong>: collected in a smaller post-canonical pass after every official E2E sample has finished, with Worker probes disabled. Legacy points use the legacy token-loop host boundary. V1 spans are recorded on the single FIFO compute stream. They include GPU compute plus device idle caused by CPU launch or queue waits. The spans are additive and sum with <strong>Host overhead</strong> back to diagnostic E2E. <strong>Prefill/Decode device wait</strong> is the corresponding span minus GPU compute. <strong>Prefill dispatch wait</strong> is submit to Prefill stage entry, <strong>Prefill / Decode CPU lead</strong> is how far CPU Decode preparation leads GPU Prefill completion, and <strong>Prefill output consumed</strong> marks the later EngineCore-visible boundary.</p><p><strong>Pipeline series</strong>: legacy <code>beam_search</code> and V1 <code>beam_search_v1</code> remain on the same metric chart with distinct lines and markers. Lines never connect different pipeline versions. The V1 series starts at <code>2026-09-18</code>: the pipeline was measured on 2026-09-17 before its stage definitions were settled, so those points are omitted from both trend charts rather than drawn as a revision. The legacy series keeps its full history.</p><p><strong>Average (Mean)</strong>: arithmetic mean over the relevant canonical or stage observations. The measurement source is shown beside every chart and comparison card.</p><p><strong>Daily trend and PRs</strong>: each date runs only that day's latest <code>decode_graph</code> snapshot; the system does not rerun the preceding SHA. Trend points show PRs merged since the preceding published daily snapshot.</p></div></section>
  <section class="vgr-section"><div class="vgr-section-head"><div><p class="vgr-kicker">Evidence</p><h2>Run history</h2></div><p>Select a run to inspect its configuration.</p></div><div id="vgr-run-history"></div></section>
</div>
