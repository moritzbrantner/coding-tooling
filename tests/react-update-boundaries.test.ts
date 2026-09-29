import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { collapseAgentEvidence } from "../src/agent-summary.ts";
import { analyzeExpectations, expectationRegistry } from "../src/expectations.ts";
import { analyzeReactUpdateBoundaries } from "../src/react-update-boundaries.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/react-update-boundaries/${name}.tsx`, import.meta.url), "utf8");
const scan = (source: string) => analyzeReactUpdateBoundaries("src/Scene.tsx", source);
const react = 'import React, {useState, useEffect, createContext} from "react";';

function repository(source: string): string {
  const root = mkdtempSync(join(tmpdir(), "react-update-boundaries-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture", scripts: { test: "bun test" } }),
  );
  writeFileSync(join(root, "src/Scene.tsx"), source);
  return root;
}

describe("React update-boundary source evidence", () => {
  test("reports exact positions for frame state, pure effect copying, and advisory context", () => {
    const source = fixture("violations");
    const findings = scan(source);
    expect(findings.map((finding) => finding.kind)).toEqual([
      "animation-frame-state",
      "effect-mirrored-state",
      "broad-context-update-risk",
    ]);
    expect(findings.map((finding) => finding.conventionId)).toEqual([
      "REACT-008",
      "REACT-009",
      "REACT-010",
    ]);
    for (const finding of findings) {
      const line = source.split("\n")[finding.startLine - 1]!;
      expect(line.slice(finding.startColumn - 1)).toStartWith(
        finding.kind === "animation-frame-state"
          ? "setFrame("
          : finding.kind === "effect-mirrored-state"
            ? "setSelection("
            : "value=",
      );
    }
    expect(scan(source)).toEqual(findings);
  });

  test("supports JavaScript and JSX React bindings without confusing unrelated setters", () => {
    const source = `${react}
function Scene() {
  const [frame, setFrame] = useState(0);
  requestAnimationFrame(() => setFrame(1));
  requestAnimationFrame((setFrame) => setFrame(1));
  return <output>{frame}</output>;
}`;
    expect(
      analyzeReactUpdateBoundaries("src/Scene.jsx", source).map((finding) => finding.kind),
    ).toEqual(["animation-frame-state"]);
    expect(
      analyzeReactUpdateBoundaries(
        "src/Scene.js",
        source.replace("return <output>{frame}</output>;", "return frame;"),
      ).map((finding) => finding.kind),
    ).toEqual(["animation-frame-state"]);
  });

  test("leaves renderer refs and DOM/media/network/store synchronization alone", () => {
    expect(scan(fixture("external-sync"))).toEqual([]);
    expect(
      scan(`${react}
      function Scene() {
        const [value, setValue] = useState(0);
        useEffect(() => { fetch('/data').then(data => setValue(data)); }, []);
        useEffect(() => store.subscribe(setValue), []);
      }`),
    ).toEqual([]);
  });

  test("keeps media and store parameters outside pure React props mirroring", () => {
    expect(
      scan(`${react}
      function useMedia(video) {
        const [time, setTime] = useState(0);
        useEffect(() => setTime(video.currentTime), [video.currentTime]);
      }
      function Scene({video, store}) {
        const [time, setTime] = useState(0);
        useEffect(() => setTime(video.currentTime), [video.currentTime]);
        useEffect(() => setTime(store.value), [store.value]);
      }`),
    ).toEqual([]);
  });

  test("recognizes aliases, namespace hooks, named frame callbacks, and local callback chains", () => {
    const source = `import * as R from "react"; import {useState as state} from "react";
      function Scene() {
        const [frame, write] = state(0);
        const [tick, setTick] = R.useState(0);
        function publish() { write(1); }
        const loop = () => { publish(); setTick(2); requestAnimationFrame(loop); };
        window.requestAnimationFrame(loop);
      }`;
    expect(scan(source).map((finding) => finding.subject)).toEqual(["frame", "tick"]);
  });

  test("does not follow deferred or unused callbacks or confused shadowed bindings", () => {
    expect(
      scan(`${react}
      function Scene() {
        const [frame, setFrame] = useState(0);
        requestAnimationFrame((setFrame) => setFrame(1));
        requestAnimationFrame(() => { const unused = () => setFrame(1); });
        requestAnimationFrame(() => { setTimeout(() => setFrame(1), 1000); });
        requestAnimationFrame(async () => { await fetch('/data'); setFrame(1); });
        function other(setFrame) { requestAnimationFrame(() => setFrame(1)); }
      }
      function Fake(useState, requestAnimationFrame) {
        const [frame, setFrame] = useState(0);
        requestAnimationFrame(() => setFrame(1));
      }`),
    ).toEqual([]);
    expect(
      scan(`import {useState} from "another-library";
      const [frame, setFrame] = useState(0); requestAnimationFrame(() => setFrame(1));`),
    ).toEqual([]);
  });

  test("ignores explicitly reassigned callbacks and setters", () => {
    expect(
      scan(`${react}
      function Scene() {
        let [frame, setFrame] = useState(0);
        setFrame = externalSetter;
        requestAnimationFrame(() => setFrame(1));
        const [tick, setTick] = useState(0);
        function publish() { setTick(1); }
        publish = externalCallback;
        requestAnimationFrame(publish);
      }`),
    ).toEqual([]);
  });

  test("mirroring requires a sole direct React-value copy and a matching dependency", () => {
    expect(
      scan(`${react}
      function Scene({selected}) {
        const [value, setValue] = useState(0);
        const [other, setOther] = React.useState(0);
        useEffect(() => setOther(value), [value]);
        React.useLayoutEffect(() => { setValue(selected); }, [selected]);
        useEffect(() => { log(selected); setValue(selected); }, [selected]);
        useEffect(() => setValue(renderer.current), [renderer.current]);
        useEffect(() => setValue(selected.current), [selected.current]);
        useEffect(() => setValue(selected.video.currentTime), [selected.video.currentTime]);
        useEffect(() => setValue(store.get()), [store]);
        useEffect(() => setValue(selected), []);
        useEffect(() => { setValue(selected); return () => cleanup(); }, [selected]);
      }`).map((finding) => finding.kind),
    ).toEqual(["effect-mirrored-state", "effect-mirrored-state"]);
  });

  test("context advisory requires local context, frequent state plus setter, and a capability", () => {
    expect(
      scan(`${react}
      const C = createContext(null);
      function Scene() {
        const [pointerPosition, setPointerPosition] = useState(0);
        const apiClient = {};
        const value = {pointerPosition, setPointerPosition, apiClient};
        return <C.Provider value={value} />;
      }`).map((finding) => finding.kind),
    ).toEqual(["broad-context-update-risk"]);
    expect(
      scan(`${react}
      const C = createContext(null);
      function Scene() {
        const [selection, setSelection] = useState(0);
        const [hover, setHover] = useState(0);
        const apiClient = {};
        return <><C.Provider value={{selection, setSelection, apiClient}} />
          <C.Provider value={{hover, apiClient}} />
          <C.Provider value={{hover, setHover}} />
          <Unknown.Provider value={{hover, setHover, apiClient}} /></>;
      }`),
    ).toEqual([]);
  });

  test("integrates stable findings, exact suppression, coverage, and strongest-evidence ordering", () => {
    const root = repository(fixture("violations"));
    const before = analyzeExpectations(root);
    const findings = before.findings.filter((finding) =>
      finding.expectationId.startsWith("react-"),
    );
    expect(findings).toHaveLength(3);
    expect(
      before.coverage.detectors
        .filter((detector) => detector.id.startsWith("react-"))
        .every((detector) => detector.status === "applied"),
    ).toBeTrue();
    const strongest = collapseAgentEvidence(
      findings.filter((finding) => finding.expectationId !== "react-effect-mirrored-state"),
      expectationRegistry(),
    )[0]!;
    expect(strongest.primaryFinding.expectationId).toBe("react-animation-frame-state");
    expect(
      findings.find((finding) => finding.expectationId === "react-broad-context-update-risk")
        ?.policyKind,
    ).toBe("advisory");
    writeFileSync(join(root, "README.md"), "unrelated");
    expect(
      analyzeExpectations(root).findings.filter((finding) =>
        finding.expectationId.startsWith("react-"),
      ),
    ).toEqual(findings);
    const frame = findings.find(
      (finding) => finding.expectationId === "react-animation-frame-state",
    )!;
    writeFileSync(
      join(root, ".coding-tooling.expectations.json"),
      JSON.stringify({
        schemaVersion: 1,
        suppressions: [
          { id: frame.id, reason: "This React UI must render every animation frame." },
        ],
      }),
    );
    expect(
      analyzeExpectations(root).findings.some((finding) => finding.id === frame.id),
    ).toBeFalse();
    expect(
      analyzeExpectations(root, { includeSuppressed: true }).findings.find(
        (finding) => finding.id === frame.id,
      )?.disposition,
    ).toBe("suppressed");
  });
});
