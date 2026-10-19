# Real TUI recording

These assets are excerpts of the maintainer's actual Reprise screen captures. UI text and results have not been recreated or replaced.

| Asset | Source | Edit |
| --- | --- | --- |
| `run.png` | `readme四张/03-stage-run.png` | Crop `(x=0, y=48, width=1900, height=510)` to remove window chrome and unused space. |
| `comparison.mp4` | `02-第一轮-comparison/reprise-tui-comparison.mp4` | Concatenate the three source intervals below, crop `(0, 50, 1900, 510)`, resize to 1520 × 408, encode H.264 at the original 15 fps. No audio. |
| `poster.png` | The edited video at 00:20 | Unmodified decoded frame showing completion. |

The 24-second video uses these source intervals (end exclusive):

1. **00:55–01:05:** candidate result page, then Comparison starts around 01:00.
2. **02:40–02:44:** Comparison running, with its text-only evaluator limitation visible.
3. **06:26–06:36:** Comparison reaches completion around 06:30 and offers the report.

Time between excerpts is omitted. Each excerpt plays at its original speed; this is not a complete real-time run. The retained top-right timer exposes the jumps. The bottom status/help area is outside the crop.

This recording is an **earlier run**. It ends at **5:30** with `report-15166fa9-3ed5-4b0a-b79a-e9fd947fa52d.html`. It is not the later pelican report `report-716c768e-2742-4535-8081-b7b65c18316a.html`, whose reported Comparison time is **5:33**. Use the video to illustrate the workflow, not as evidence that it generated the later report or visually verified its findings.

Verification: the edited video decodes without errors; metadata reports 24 seconds, 1520 × 408, 15 fps, and 246,713 bytes. Source start/completion transitions and one frame per output second were inspected. Selected frames contain no visible credentials or private absolute filesystem paths. The run screenshot was checked at full resolution. Original recordings remain unchanged.
