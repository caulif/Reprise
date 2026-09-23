import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import {
  HistoricalArtifactManifestSchema,
} from "../../src/core/schema.js";
import { sha256 } from "../../src/core/identity.js";
import { codexSessionAdapter } from "../../src/products/packs/codex/sessions.js";
import { claudeSessionAdapter } from "../../src/products/packs/claude-code/sessions.js";
import { extractStaticApplyPatchFromExec } from "../../src/products/packs/codex/historical-artifacts.js";
import { isCodexShellTool } from "../../src/products/packs/codex/historical-artifact-policy.js";
import { fakeSessionAdapter } from "../fixtures/fake-pack/sessions.js";
import type { HistoricalArtifactExtractInput } from "../../src/products/contract.js";

function bytesOf(result: { files: readonly { artifactId: string; bytes: Uint8Array }[] }, logicalPath: string, manifest: { artifacts: readonly { logicalPath: string; artifactId: string }[] }): Buffer {
  const artifact = manifest.artifacts.find((item) => item.logicalPath === logicalPath);
  assert.ok(artifact, `missing artifact ${logicalPath}`);
  const file = result.files.find((item) => item.artifactId === artifact.artifactId);
  assert.ok(file);
  return Buffer.from(file.bytes);
}

function codexCall(callId: string, name: string, args: unknown) {
  return {
    timestamp: "2026-09-19T00:00:00.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: callId,
      name,
      arguments: typeof args === "string" ? args : JSON.stringify(args),
    },
  };
}

function codexOutput(callId: string, output: string) {
  return {
    timestamp: "2026-09-19T00:00:01.000Z",
    type: "response_item",
    payload: {
      type: "function_call_output",
      call_id: callId,
      output,
    },
  };
}

function customExecCall(callId: string, input: string) {
  return { type: "response_item", payload: { type: "custom_tool_call", call_id: callId, name: "exec", input } };
}

function customExecOutput(callId: string, completed = true) {
  return {
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: callId,
      output: [
        { type: "input_text", text: completed ? "Script completed\nWall time 0.0 seconds\nOutput:\n" : "Script failed\nError:\npatch rejected" },
        { type: "input_text", text: completed ? "{}" : "Error: patch rejected" },
      ],
    },
  };
}

function execPatchScript(patch: string): string {
  return `const patch = ${JSON.stringify(patch)};\nconst r = await tools.apply_patch(patch); text(r);`;
}

function addPatch(path: string, body: string): string {
  const lines = body.split("\n").map((line) => `+${line}`).join("\n");
  return `*** Begin Patch\n*** Add File: ${path}\n${lines}\n*** End Patch\n`;
}

function updatePatch(path: string, oldLine: string, newLine: string): string {
  return `*** Begin Patch\n*** Update File: ${path}\n@@\n-${oldLine}\n+${newLine}\n*** End Patch\n`;
}

function deletePatch(path: string): string {
  return `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch\n`;
}

test("optional extractHistoricalArtifacts is not required for third-party packs", () => {
  assert.equal(typeof fakeSessionAdapter.extractHistoricalArtifacts, "undefined");
  assert.equal(typeof codexSessionAdapter.extractHistoricalArtifacts, "function");
  assert.equal(typeof claudeSessionAdapter.extractHistoricalArtifacts, "function");
});

test("Codex Add then successful Update yields final bytes", () => {
  const input: HistoricalArtifactExtractInput = {
    transcript: [{ id: "u1", role: "user", text: "write file" }],
    historicalEvents: [
      codexCall("c1", "apply_patch", { patch: addPatch("notes/hello.txt", "v1") }),
      codexOutput("c1", "Success. Updated the following files:\nA notes/hello.txt"),
      codexCall("c2", "apply_patch", { patch: updatePatch("notes/hello.txt", "v1", "v2-final") }),
      codexOutput("c2", "Success"),
    ],
  };
  const result = codexSessionAdapter.extractHistoricalArtifacts!(input);
  assert.equal(Value.Check(HistoricalArtifactManifestSchema, result.manifest), true);
  assert.equal(result.manifest.artifacts.length, 1);
  assert.equal(result.manifest.artifacts[0]?.finality, "final");
  assert.equal(bytesOf(result, "notes/hello.txt", result.manifest).toString("utf8"), "v2-final");
  assert.equal(result.manifest.artifacts[0]?.contentHash, sha256(Buffer.from("v2-final")));
});

test("Codex Add then Delete removes openable final", () => {
  const input: HistoricalArtifactExtractInput = {
    transcript: [],
    historicalEvents: [
      codexCall("c1", "apply_patch", { patch: addPatch("gone.txt", "temp") }),
      codexOutput("c1", "ok"),
      codexCall("c2", "apply_patch", { patch: deletePatch("gone.txt") }),
      codexOutput("c2", "ok"),
    ],
  };
  const result = codexSessionAdapter.extractHistoricalArtifacts!(input);
  assert.equal(result.manifest.artifacts.length, 0);
  assert.equal(result.files.length, 0);
});

test("Codex Add then unknown shell rewrite cannot keep Add as final", () => {
  const input: HistoricalArtifactExtractInput = {
    transcript: [],
    historicalEvents: [
      codexCall("c1", "apply_patch", { patch: addPatch("anim.html", "<svg></svg>") }),
      codexOutput("c1", "ok"),
      codexCall("c2", "shell_command", { command: "node -e \"require('fs').writeFileSync('anim.html', dynamic())\"" }),
      codexOutput("c2", "ok"),
    ],
  };
  const result = codexSessionAdapter.extractHistoricalArtifacts!(input);
  assert.equal(result.manifest.artifacts.some((item) => item.logicalPath === "anim.html" && item.finality === "final"), false);
  assert.ok(result.manifest.issues.some((issue) => issue.code === "unsupported_write"));
});

test("Codex patch preserves Chinese quotes backslash CRLF and BOM bytes", () => {
  // CR is embedded inside a content line so patch line-splitting does not consume it.
  const withCr = `\uFEFF中文"quote"\\path\rkeep`;
  const patchText = [
    "*** Begin Patch",
    "*** Add File: mixed.txt",
    `+${withCr}`,
    "+line2",
    "*** End Patch",
    "",
  ].join("\n");
  const input: HistoricalArtifactExtractInput = {
    transcript: [],
    historicalEvents: [
      codexCall("c1", "apply_patch", { patch: patchText }),
      codexOutput("c1", "ok"),
    ],
  };
  const result = codexSessionAdapter.extractHistoricalArtifacts!(input);
  const bytes = bytesOf(result, "mixed.txt", result.manifest);
  assert.equal(bytes[0], 0xef);
  assert.equal(bytes[1], 0xbb);
  assert.equal(bytes[2], 0xbf);
  assert.match(bytes.toString("utf8"), /中文"quote"\\path/);
  assert.ok(bytes.includes(0x0d), "CR preserved inside content");
  assert.equal(bytes.toString("utf8"), `${withCr}\nline2`);
});

test("malicious JS in exec string is not executed; unsupported", () => {
  const command = [
    'const patch = (() => { throw new Error("boom"); })();',
    "apply_patch(patch);",
  ].join("\n");
  assert.equal(extractStaticApplyPatchFromExec(command).status, "unsupported");
  const input: HistoricalArtifactExtractInput = {
    transcript: [],
    historicalEvents: [
      codexCall("c1", "shell_command", { command }),
      codexOutput("c1", "ok"),
    ],
  };
  const result = codexSessionAdapter.extractHistoricalArtifacts!(input);
  assert.equal(result.manifest.artifacts.length, 0);
  assert.ok(result.manifest.issues.some((issue) => issue.code === "unsupported_write"));
});

test("static exec-wrapped apply_patch decodes double-quoted literal", () => {
  const inner = addPatch("pelican_bike.html", "<html>ok</html>");
  const command = `const patch = ${JSON.stringify(inner)};\napply_patch(patch);`;
  const extracted = extractStaticApplyPatchFromExec(command);
  assert.equal(extracted.status, "ok");
  const input: HistoricalArtifactExtractInput = {
    transcript: [],
    historicalEvents: [
      codexCall("c1", "shell_command", { command }),
      codexOutput("c1", "ok"),
    ],
  };
  const result = codexSessionAdapter.extractHistoricalArtifacts!(input);
  assert.equal(bytesOf(result, "pelican_bike.html", result.manifest).toString("utf8"), "<html>ok</html>");
});

test("custom exec reconstructs a verified static HTML patch from the frozen call shape", () => {
  const html = "<!doctype html>\n<html lang=\"zh-CN\"><body>bike</body></html>";
  const inspection = "$p = Join-Path (Get-Location) 'pelican_bike.html'; $s = Get-Content -Raw -LiteralPath $p; [pscustomobject]@{Exists=(Test-Path -LiteralPath $p); Bytes=(Get-Item -LiteralPath $p).Length; HtmlOpen=([regex]::Matches($s,'<html').Count); SvgOpen=([regex]::Matches($s,'<svg').Count); SvgClose=([regex]::Matches($s,'</svg>').Count); AnimationRules=([regex]::Matches($s,'@keyframes').Count); ToggleScript=($s -match 'toggleAnimation') } | Format-List";
  const events = [
    customExecCall("read", 'const r = await tools.exec_command({cmd:"Get-ChildItem"}); text(r.output);'),
    customExecOutput("read"),
    customExecCall("write", execPatchScript(addPatch("pelican_bike.html", html))),
    customExecOutput("write"),
    customExecCall("inspect", `const r = await tools.exec_command({cmd:${JSON.stringify(inspection)},workdir:${JSON.stringify("C:\\fixture\\project")}}); text(r.output);`),
    customExecOutput("inspect"),
  ];
  const result = codexSessionAdapter.extractHistoricalArtifacts!({ transcript: [], historicalEvents: events });
  const bytes = bytesOf(result, "pelican_bike.html", result.manifest);
  assert.equal(bytes.toString("utf8"), html);
  assert.equal(result.manifest.artifacts[0]?.byteLength, Buffer.byteLength(html));
  assert.equal(result.manifest.artifacts[0]?.contentHash, sha256(Buffer.from(html)));
  assert.deepEqual(result.manifest.artifacts[0]?.sourceRefs, ["event:history-2", "event:history-3"]);
  assert.deepEqual(result.manifest.issues, []);
});

test("custom exec rejects dynamic, repeated, incomplete, and unverified patch writes", () => {
  const patch = addPatch("pelican_bike.html", "static");
  const scripts = [
    'const patch = makePatch(); const r = await tools.apply_patch(patch); text(r);',
    `${execPatchScript(patch)}\nawait tools.apply_patch(patch);`,
    execPatchScript(patch.replace("*** End Patch\n", "")),
    `const patch = ${JSON.stringify(patch)}; const r = await tools.apply_patch(patch); await tools.exec_command({cmd:"Set-Content pelican_bike.html changed"}); text(r);`,
    'const r = await tools.exec_command({cmd:"Set-Content pelican_bike.html changed"}); text(r.output);',
    'const r = await tools.someUnknownTool({path:"pelican_bike.html"}); text(r);',
  ];
  for (const [index, script] of scripts.entries()) {
    const result = codexSessionAdapter.extractHistoricalArtifacts!({
      transcript: [], historicalEvents: [customExecCall("write", script), customExecOutput("write")],
    });
    assert.equal(result.manifest.artifacts.length, 0, `case ${index}`);
    assert.ok(result.manifest.issues.some((issue) => issue.code === "unsupported_write" && issue.sourceRefs.includes("event:history-0")), `case ${index}`);
  }
  const failed = codexSessionAdapter.extractHistoricalArtifacts!({
    transcript: [], historicalEvents: [customExecCall("write", execPatchScript(patch)), customExecOutput("write", false)],
  });
  assert.equal(failed.manifest.artifacts.length, 0);
  assert.ok(failed.manifest.issues.some((issue) => issue.code === "failed_tool"));
  const unverified = codexSessionAdapter.extractHistoricalArtifacts!({
    transcript: [], historicalEvents: [
      customExecCall("write", execPatchScript(patch)),
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "write", output: "ok" } },
    ],
  });
  assert.equal(unverified.manifest.artifacts.length, 0);
  assert.ok(unverified.manifest.issues.some((issue) => issue.code === "ambiguous_version"));
  const missingOutput = codexSessionAdapter.extractHistoricalArtifacts!({
    transcript: [], historicalEvents: [customExecCall("write", execPatchScript(patch))],
  });
  assert.ok(missingOutput.manifest.issues.some((issue) => issue.code === "ambiguous_version"));
  const opaqueInput = codexSessionAdapter.extractHistoricalArtifacts!({
    transcript: [], historicalEvents: [
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "write", name: "exec", input: { code: "opaque" } } },
      customExecOutput("write"),
    ],
  });
  assert.ok(opaqueInput.manifest.issues.some((issue) => issue.code === "unsupported_write"));
});

test("custom exec applies the same path containment checks as direct patches", () => {
  const result = codexSessionAdapter.extractHistoricalArtifacts!({
    transcript: [],
    historicalEvents: [customExecCall("write", execPatchScript(addPatch("../pelican_bike.html", "x"))), customExecOutput("write")],
  });
  assert.equal(result.manifest.artifacts.length, 0);
  assert.ok(result.manifest.issues.some((issue) => issue.code === "path_rejected"));
});

test("later opaque custom exec write invalidates an earlier reconstructed final", () => {
  for (const command of [
    "Set-Content pelican_bike.html revised",
    "git apply update.patch",
    "Get-Content pelican_bike.html; git apply update.patch",
    "npm run generate",
    "pwsh -Command Invoke-Expression $script",
    "gci | % { arbitrary($_) }",
  ]) {
    const result = codexSessionAdapter.extractHistoricalArtifacts!({
      transcript: [],
      historicalEvents: [
        customExecCall("first", execPatchScript(addPatch("pelican_bike.html", "original"))),
        customExecOutput("first"),
        customExecCall("second", `const r = await tools.exec_command({cmd:${JSON.stringify(command)}}); text(r.output);`),
        customExecOutput("second"),
      ],
    });
    assert.equal(result.manifest.artifacts.length, 0, command);
    assert.ok(result.manifest.issues.some((issue) => issue.code === "unsupported_write" && issue.sourceRefs.includes("event:history-2")), command);
  }
});

test("path traversal absolute UNC drive and ADS are rejected", () => {
  const badPaths = ["../secret.txt", "/etc/passwd", "C:/Windows/a.txt", "//server/share/a.txt", "file.txt:ads"];
  for (const logicalPath of badPaths) {
    const input: HistoricalArtifactExtractInput = {
      transcript: [],
      historicalEvents: [
        codexCall("c1", "apply_patch", { patch: addPatch(logicalPath, "x") }),
        codexOutput("c1", "ok"),
      ],
    };
    const result = codexSessionAdapter.extractHistoricalArtifacts!(input);
    assert.equal(result.manifest.artifacts.length, 0, logicalPath);
    assert.ok(result.manifest.issues.some((issue) => issue.code === "path_rejected"), logicalPath);
  }
});

test("same basename in two directories keep distinct identities", () => {
  const input: HistoricalArtifactExtractInput = {
    transcript: [],
    historicalEvents: [
      codexCall("c1", "apply_patch", { patch: addPatch("a/index.html", "A") }),
      codexOutput("c1", "ok"),
      codexCall("c2", "apply_patch", { patch: addPatch("b/index.html", "B") }),
      codexOutput("c2", "ok"),
    ],
  };
  const result = codexSessionAdapter.extractHistoricalArtifacts!(input);
  assert.equal(result.manifest.artifacts.length, 2);
  const ids = new Set(result.manifest.artifacts.map((item) => item.artifactId));
  assert.equal(ids.size, 2);
  assert.equal(bytesOf(result, "a/index.html", result.manifest).toString("utf8"), "A");
  assert.equal(bytesOf(result, "b/index.html", result.manifest).toString("utf8"), "B");
});

test("failed tool call and missing preimage do not forge final", () => {
  const input: HistoricalArtifactExtractInput = {
    transcript: [],
    historicalEvents: [
      codexCall("c1", "apply_patch", { patch: addPatch("x.txt", "one") }),
      codexOutput("c1", "[error] patch failed"),
      codexCall("c2", "apply_patch", { patch: updatePatch("missing.txt", "a", "b") }),
      codexOutput("c2", "ok"),
    ],
  };
  const result = codexSessionAdapter.extractHistoricalArtifacts!(input);
  assert.equal(result.manifest.artifacts.length, 0);
  assert.ok(result.manifest.issues.some((issue) => issue.code === "failed_tool"));
  assert.ok(result.manifest.issues.some((issue) => issue.code === "missing_preimage"));
});

test("case-only path conflict is reported and not silently merged", () => {
  const input: HistoricalArtifactExtractInput = {
    transcript: [],
    historicalEvents: [
      codexCall("c1", "apply_patch", { patch: addPatch("Readme.md", "A") }),
      codexOutput("c1", "ok"),
      codexCall("c2", "apply_patch", { patch: addPatch("readme.md", "B") }),
      codexOutput("c2", "ok"),
    ],
  };
  const result = codexSessionAdapter.extractHistoricalArtifacts!(input);
  assert.ok(result.manifest.issues.some((issue) => issue.code === "path_conflict"));
  assert.equal(result.manifest.artifacts.filter((item) => item.finality === "final").length, 0);
});

test("Claude Write then unique Edit yields final bytes", () => {
  const input: HistoricalArtifactExtractInput = {
    transcript: [],
    historicalEvents: [
      {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "t1",
            name: "Write",
            input: { file_path: "out/hi.txt", content: "alpha" },
          }],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "Wrote" }],
        },
      },
      {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "t2",
            name: "Edit",
            input: { file_path: "out/hi.txt", old_string: "alpha", new_string: "omega" },
          }],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t2", content: "Edited" }],
        },
      },
    ],
  };
  const result = claudeSessionAdapter.extractHistoricalArtifacts!(input);
  assert.equal(Value.Check(HistoricalArtifactManifestSchema, result.manifest), true);
  assert.equal(bytesOf(result, "out/hi.txt", result.manifest).toString("utf8"), "omega");
});

test("manifest JSON omits file bytes; hash matches sha256 of extracted bytes", () => {
  const body = "<!doctype html><html></html>";
  const input: HistoricalArtifactExtractInput = {
    transcript: [],
    historicalEvents: [
      codexCall("c1", "apply_patch", { patch: addPatch("card.html", body) }),
      codexOutput("c1", "ok"),
    ],
  };
  const result = codexSessionAdapter.extractHistoricalArtifacts!(input);
  const serialized = JSON.stringify(result.manifest);
  assert.doesNotMatch(serialized, /doctype html/);
  const artifact = result.manifest.artifacts[0]!;
  const file = result.files[0]!;
  assert.equal(artifact.contentHash, createHash("sha256").update(file.bytes).digest("hex"));
  assert.equal(artifact.byteLength, file.bytes.byteLength);
});

test("tool call without result is not sealed as final", () => {
  const input: HistoricalArtifactExtractInput = {
    transcript: [],
    historicalEvents: [
      codexCall("c1", "apply_patch", { patch: addPatch("pending.txt", "x") }),
    ],
  };
  const result = codexSessionAdapter.extractHistoricalArtifacts!(input);
  assert.equal(result.manifest.artifacts.length, 0);
  assert.ok(result.manifest.issues.some((issue) => issue.code === "ambiguous_version"));
});

test("Codex shell fail-closed: python sed bash and co-mutators drop prior finals", () => {
  const cases: Array<{ name: string; args: unknown }> = [
    { name: "shell_command", args: { command: 'python -c "open(\'a.txt\',\'w\').write(\'x\')"' } },
    { name: "shell_command", args: { command: "sed -i 's/v1/v2/' a.txt" } },
    { name: "bash", args: { command: 'python -c "open(\'a.txt\',\'w\').write(\'x\')"' } },
    {
      name: "shell_command",
      args: {
        command: `const patch = ${JSON.stringify(addPatch("a.txt", "from-patch"))};\napply_patch(patch);\nrequire('fs').writeFileSync('a.txt','mutated')`,
      },
    },
  ];
  for (const [index, item] of cases.entries()) {
    const input: HistoricalArtifactExtractInput = {
      transcript: [],
      historicalEvents: [
        codexCall("c1", "apply_patch", { patch: addPatch("a.txt", "v1") }),
        codexOutput("c1", "ok"),
        codexCall(`c2-${index}`, item.name, item.args),
        codexOutput(`c2-${index}`, "ok"),
      ],
    };
    const result = codexSessionAdapter.extractHistoricalArtifacts!(input);
    assert.equal(result.manifest.artifacts.length, 0, item.name);
    assert.ok(result.manifest.issues.some((issue) => issue.code === "unsupported_write"), item.name);
  }
});

test("Codex shell allowlist rejects execute and mcp_exec substring over-match", () => {
  assert.equal(isCodexShellTool("bash"), true);
  assert.equal(isCodexShellTool("shell_command"), true);
  assert.equal(isCodexShellTool("execute"), false);
  assert.equal(isCodexShellTool("mcp_exec"), false);
  assert.equal(isCodexShellTool("container.exec"), false);
  for (const [index, name] of ["execute", "mcp_exec"].entries()) {
    const input: HistoricalArtifactExtractInput = {
      transcript: [],
      historicalEvents: [
        codexCall("c1", "apply_patch", { patch: addPatch("keep.txt", "safe") }),
        codexOutput("c1", "ok"),
        codexCall(`c2-${index}`, name, { command: "not-a-shell" }),
        codexOutput(`c2-${index}`, "ok"),
      ],
    };
    const result = codexSessionAdapter.extractHistoricalArtifacts!(input);
    assert.equal(bytesOf(result, "keep.txt", result.manifest).toString("utf8"), "safe", name);
  }
});

test("Claude successful Bash after Write cannot keep prior bytes as final", () => {
  const input: HistoricalArtifactExtractInput = {
    transcript: [],
    historicalEvents: [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t1", name: "Write", input: { file_path: "out/hi.txt", content: "alpha" } }],
        },
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Wrote" }] } },
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "t2", name: "Bash", input: { command: "echo mutated > out/hi.txt" } }],
        },
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } },
    ],
  };
  const result = claudeSessionAdapter.extractHistoricalArtifacts!(input);
  assert.equal(result.manifest.artifacts.length, 0);
  assert.ok(result.manifest.issues.some((issue) => issue.code === "unsupported_write"));
});

test("Claude absolute file_path relativizes via historicalCwd and rejects outside root", () => {
  // Segmented so verify-secrets does not treat a contiguous Users path as a host leak.
  const cwd = ["D:", "/fixture", "/workspace"].join("");
  const outsidePath = ["E:", "/elsewhere", "/secret.txt"].join("");
  const inside: HistoricalArtifactExtractInput = {
    transcript: [],
    historicalCwd: cwd,
    historicalEvents: [
      {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "t1",
            name: "Write",
            input: { file_path: `${cwd}/out/hi.txt`, content: "abs-ok" },
          }],
        },
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Wrote" }] } },
    ],
  };
  const ok = claudeSessionAdapter.extractHistoricalArtifacts!(inside);
  assert.equal(bytesOf(ok, "out/hi.txt", ok.manifest).toString("utf8"), "abs-ok");

  const outside: HistoricalArtifactExtractInput = {
    transcript: [],
    historicalCwd: cwd,
    historicalEvents: [
      {
        type: "assistant",
        message: {
          content: [{
            type: "tool_use",
            id: "t1",
            name: "Write",
            input: { file_path: outsidePath, content: "nope" },
          }],
        },
      },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "Wrote" }] } },
    ],
  };
  const rejected = claudeSessionAdapter.extractHistoricalArtifacts!(outside);
  assert.equal(rejected.manifest.artifacts.length, 0);
  assert.ok(rejected.manifest.issues.some((issue) => issue.code === "path_rejected"));

  const noCwd: HistoricalArtifactExtractInput = {
    transcript: [],
    historicalEvents: outside.historicalEvents,
  };
  const missing = claudeSessionAdapter.extractHistoricalArtifacts!(noCwd);
  assert.equal(missing.manifest.artifacts.length, 0);
  assert.ok(missing.manifest.issues.some((issue) => issue.code === "path_rejected"));
});
