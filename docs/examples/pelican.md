# Pelican on a bicycle: a real delivery comparison

[简体中文](pelican-zh-cn.md) · [Back to Reprise](../../README.md)

The original request was: “不用skills，创建一个HTML，内容是SVG绘制一个鹈鹕骑自行车的2D动画” — create an HTML page containing an SVG 2D animation of a pelican riding a bicycle, without using skills.

Reprise recovered the historical HTML from recorded file edits and compared it with a preserved candidate workspace. This case shows why looking at the actual deliveries matters: the candidate changes the cycling mechanism, but also loses a useful playback control.

![Historical and candidate pelican HTML deliveries at equal viewport sizes, with provenance labels](../assets/pelican/comparison.png)

## Watch the deliveries

[Open the short animation](../assets/pelican/comparison.gif) (3 seconds, approximately 3 MB). It is a recording of the existing HTML outputs playing in Chromium, **not a recording of a new Reprise run**. It contains motion; use the static image above if preferred. The clip loops for presentation and does not represent a seamless animation cycle.

After cloning the repository, open [showcase.html](../assets/pelican/showcase.html) locally to view both outputs, or inspect [historical.html](../assets/pelican/historical.html) and [candidate.html](../assets/pelican/candidate.html). GitHub displays HTML source rather than running these files. The two original HTML files are copied byte for byte; only the surrounding comparison page and media are new. Both outputs are self-contained: this preview requires no model, login, server, or external assets.

## What differs

These observations were independently checked against the HTML source and a fresh local Chromium playback on 2026-10-19. They are an editorial summary, not the original generated report.

| Detail | Historical delivery | Candidate delivery |
| --- | --- | --- |
| Wheels | Both sets of spokes share one rotating group, whose origin is between the wheels. The rims remain stationary while spokes move away from their hubs. | Each wheel has its own rotation origin at its hub. |
| Pedalling | The feet remain in the rider group while a separate crank spins. | A script updates the crank, legs and feet from a common angle. This improves coordination; it does not establish physically exact foot contact or a realistic bicycle model. |
| Controls and scenery | Click, Enter or Space toggles pause. Reduced-motion preference effectively stops CSS animation. | Adds scrolling scenery, but has no pause control. Reduced-motion preference slows some motion rather than stopping it. The tree layer falls short of the right edge during part of its cycle. |

The public preview intentionally preserves those defects. It is useful for examining concrete implementation tradeoffs, not for declaring one model universally better.

## Where this example comes from

The retained report records these tool and model labels:

| Side | Tool | Recorded model |
| --- | --- | --- |
| Historical | Codex | `gpt-6-astra` |
| Candidate | Claude Code | `deepseek/deepseek-v4.1-flash` |

- The Comparison report was regenerated on **2026-10-19**, using existing candidate results from **2026-10-16**. Recovery and candidate execution were not rerun for this publication.
- Report generation used Reprise commit [`c29992e`](https://github.com/caulif/Reprise/commit/c29992e7895b6d31f5bd6241c5819282acae6933), report format **6**. This page is a curated example, not a claim about the output of every later version.
- The historical artifact manifest marks the HTML as **final, reconstructed from history**, using recorded file edits. It is not a freshly retrieved original filesystem file or a manually substituted reference.
- The candidate HTML is from the preserved execution snapshot. These two downloadable copies retain the recovered/snapshotted bytes; screenshots use equal 640 × 380 iframe viewports, with each output retaining its own responsive layout.
- The original empty Recovery baseline is no longer available. The retained materials cannot establish complete end-to-end reproducibility of the historical environment.
- The report marks timing as **not comparable** (`timingComparable=false`); equal task scope was not established. No speed ranking or cost-saving claim is made. Estimated usage is not a verified supplier bill.

The original report raised the wheel, pedalling, background and control differences. This publication checked the source mechanisms, sampled 24 animation states over about 3.6 seconds, verified pause/resume and reduced-motion behavior, and inspected desktop and narrow-screen previews. A short playback and samples do not prove smoothness over all cycles, browsers or devices. No model calls were made to create this public preview.

## Try a task of your own

Follow the [first-run guide](../getting-started.md) to configure the required model/tool access, import a local task and inspect its resulting report. Choose a small task first and read the fee and recovery limitations before execution.
