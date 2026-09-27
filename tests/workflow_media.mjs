import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Window } from "happy-dom";
import {
  workflowMediaSnapshot, createMediaMaterializer, createFileDropEvent,
  createWorkflowMediaTransfer, clampPanelPosition,
} from "../web/workflow_media.js";

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness(type = null, materialize = async () => new File(["original bytes"], "picture.png", { type: "image/png" })) {
  let id = 0, hit = null, revision = 0, currentMedia = true;
  const received = [];
  function makeNode(type) {
    return {
      id: ++id, type, outputs: [{ links: [] }],
      widgets: [{ name: "custom_source", value: "old" }, { name: "other_setting", value: 16 }],
      async onDragDrop(event) {
        const file = event.dataTransfer.files[0];
        received.push({ node: this, event, file });
        this.widgets[0].value = file.name;
        this.preview = { filename: file.name, type: file.type };
        return true;
      },
    };
  }
  const graph = {
    _nodes: [], changes: [], getNodeOnPos: () => hit,
    getNodeById: id => graph._nodes.find(node => node.id === id),
    add(node) { graph._nodes.push(node); },
    remove(node) { graph._nodes.splice(graph._nodes.indexOf(node), 1); },
    beforeChange() { graph.changes.push("before"); },
    afterChange() { graph.changes.push("after"); },
    setDirtyCanvas() {},
  };
  const canvas = {};
  const app = { canvas: { graph, canvas }, clientPosToCanvasPos: ([x, y]) => [x / 2, y / 2] };
  const liteGraph = {
    registered_node_types: { LoadImage: {}, LoadVideo: {}, LoadAudio: {} },
    createNode: makeNode,
  };
  if (type) {
    hit = makeNode(type);
    hit.outputs[0].links.push(42);
    graph.add(hit);
  }
  const transfer = createWorkflowMediaTransfer({
    app, liteGraph, materialize,
    getWorkflowRevision: () => revision,
    isCurrentMedia: () => currentMedia,
    createDropEvent: (file, point, element) => ({
      dataTransfer: { types: ["Files"], files: [file] },
      clientX: point[0], clientY: point[1], target: element,
    }),
  });
  return {
    app, canvas, graph, liteGraph, transfer, node: hit, received,
    switchWorkflow() { revision++; },
    changeMedia() { currentMedia = false; },
  };
}

test("workflow snapshots select original/applied media, never a preview or an unapplied draft", () => {
  for (const type of ["image", "video", "audio"]) {
    const asset = { id: "a", session_id: "s", type, content_url: "/original", preview_url: "/sheet", content_revision: 4 };
    const snapshot = workflowMediaSnapshot(asset);
    assert.equal(snapshot.kind, type);
    assert.match(snapshot.url, /kind=workflow&revision=4$/);
    assert.doesNotMatch(snapshot.url, /sheet/);
    assert.notEqual(workflowMediaSnapshot({ ...asset, content_revision: 5 }).url, snapshot.url);
  }
  assert.equal(workflowMediaSnapshot({ type: "image" }), null);
});

test("unknown custom loaders own file upload, preview updates and unrelated widgets", async () => {
  const h = harness("ThirdPartyLoaderNotKnownToWriter");
  const originalWidgets = h.node.widgets;
  assert.equal(await h.transfer.drop({ kind: "image" }, [100, 200]), h.node);
  assert.equal(h.received.length, 1);
  assert.equal(h.received[0].node, h.node);
  assert.equal(await h.received[0].file.text(), "original bytes");
  assert.deepEqual(h.node.preview, { filename: "picture.png", type: "image/png" });
  assert.equal(h.node.widgets, originalWidgets);
  assert.equal(h.node.widgets[1].value, 16);
  assert.deepEqual(h.node.outputs[0].links, [42]);
  assert.equal(h.graph._nodes.length, 1);
  assert.deepEqual(h.graph.changes, ["before", "after"]);
});

test("empty canvas creates the standard loader and calls only its file handler", async () => {
  for (const [kind, type] of [["image", "LoadImage"], ["video", "LoadVideo"], ["audio", "LoadAudio"]]) {
    const h = harness();
    h.app.handleFile = () => assert.fail("Must not import PNG workflow metadata");
    h.canvas.dispatchEvent = () => assert.fail("Must not broadcast drop to the canvas");
    const node = await h.transfer.drop({ kind }, [100, 200]);
    assert.equal(node.type, type);
    assert.deepEqual(node.pos, [50, 100]);
    assert.equal(h.graph._nodes.length, 1);
    assert.equal(h.received.length, 1);
  }
});

test("a node DOM preview is accepted, but unrelated overlays cannot create or replace loaders", async () => {
  const h = harness("CustomPreviewLoader");
  const preview = {};
  h.node.widgets.push({ element: { contains: element => element === preview } });
  await h.transfer.drop({ kind: "image" }, [0, 0], undefined, preview);
  assert.equal(h.received[0].event.target, preview);
  await assert.rejects(h.transfer.drop({ kind: "image" }, [0, 0], undefined, {}), /workflow canvas/);
  const empty = harness();
  await assert.rejects(empty.transfer.drop({ kind: "image" }, [0, 0], undefined, {}), /workflow canvas/);
  assert.equal(empty.graph._nodes.length, 0);
});

test("unsupported and busy receivers and read-only graphs reject before reading media", async () => {
  for (const change of [
    h => { h.node.onDragDrop = undefined; },
    h => { h.node.isUploading = true; },
    h => { h.app.canvas.read_only = true; },
    h => { h.app.canvas.allow_interaction = false; },
  ]) {
    const h = harness("CustomLoader", () => assert.fail("Unsupported target must not read media"));
    change(h);
    await assert.rejects(h.transfer.drop({ kind: "image" }, [0, 0]));
    assert.equal(h.graph._nodes.length, 1);
  }
});

test("a refused or failed handler never falls back to canvas import or another node", async () => {
  for (const handler of [() => false, () => { throw Error("upload failed"); }]) {
    const h = harness("CustomLoader");
    h.node.onDragDrop = handler;
    await assert.rejects(h.transfer.drop({ kind: "image" }, [0, 0]));
    assert.equal(h.graph._nodes.length, 1);
    assert.equal(h.node.widgets[0].value, "old");
    assert.deepEqual(h.node.outputs[0].links, [42]);
    assert.deepEqual(h.graph.changes, ["before", "after"]);

    const empty = harness();
    const makeNode = empty.liteGraph.createNode;
    empty.liteGraph.createNode = type => ({ ...makeNode(type), onDragDrop: handler });
    await assert.rejects(empty.transfer.drop({ kind: "image" }, [0, 0]));
    assert.equal(empty.graph._nodes.length, 0);
  }
});

test("graph, receiver and media changes during file preparation prevent delivery", async () => {
  for (const change of [
    h => { h.app.canvas.graph = {}; }, h => h.switchWorkflow(), h => h.changeMedia(),
    h => h.graph.remove(h.node), h => { h.graph._nodes = []; },
    h => { h.node.widgets[0].value = "user-choice.png"; },
    h => { h.node.onDragDrop = () => true; }, h => { h.node.isUploading = true; },
    h => { h.app.canvas.read_only = true; },
  ]) {
    const wait = deferred();
    const h = harness("CustomLoader", () => wait.promise);
    const pending = h.transfer.drop({ kind: "image" }, [0, 0]);
    change(h);
    wait.resolve(new File(["bytes"], "picture.png"));
    await assert.rejects(pending);
    assert.equal(h.received.length, 0);
  }
});

test("cancelled preparation can be replaced without the old job delivering its file", async () => {
  const wait = deferred();
  let calls = 0;
  const h = harness(null, () => ++calls === 1 ? wait.promise : new File(["new"], "new.png"));
  const controller = new AbortController();
  const pending = h.transfer.drop({ kind: "image" }, [0, 0], controller.signal);
  controller.abort();
  await h.transfer.drop({ kind: "image" }, [0, 0]);
  wait.resolve(new File(["old"], "old.png"));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(h.graph._nodes.length, 1);
  assert.equal(h.received[0].file.name, "new.png");
});

test("an already dispatched third-party upload finishes once and cannot overlap another transfer", async () => {
  const wait = deferred(), started = deferred(), controller = new AbortController();
  const h = harness("CustomLoader");
  h.node.onDragDrop = async () => { started.resolve(); await wait.promise; return true; };
  const pending = h.transfer.drop({ kind: "image" }, [0, 0], controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(h.transfer.drop({ kind: "image" }, [0, 0]), /Finish the current/);
  wait.resolve();
  assert.equal(await pending, h.node);
  assert.deepEqual(h.node.outputs[0].links, [42]);
});

test("materialization preserves bytes and readable filenames without a second upload", async () => {
  const calls = [];
  const readFile = createMediaMaterializer(async url => {
    calls.push(url);
    return new Response("PNG including workflow metadata", {
      headers: { "Content-Type": "image/png", "Content-Disposition": "inline; filename*=UTF-8''My%20photo.png" },
    });
  });
  const a = await readFile({ url: "/original", filename: "My photo.png" });
  const b = await readFile({ url: "/original", filename: "My photo.png" });
  const c = await readFile({ url: "/edited", filename: "My photo.jpg" });
  assert.equal(a.name, "pw-My photo.png");
  assert.equal(a.name, b.name);
  assert.equal(c.name, "pw-My photo.png", "Applied content format determines the extension");
  assert.equal(a.type, "image/png");
  assert.equal(await a.text(), "PNG including workflow metadata");
  assert.deepEqual(calls, ["/original", "/original", "/edited"]);
  await assert.rejects(createMediaMaterializer(async () => new Response("", { status: 409 }))({ url: "/stale" }), /Media changed/);
});

test("server-provided audio metadata reaches new and existing file receivers", async () => {
  for (const [extension, contentType] of [["ogg", "audio/ogg"], ["wav", "audio/wav"], ["mp3", "audio/mpeg"]]) {
    const materialize = createMediaMaterializer(async () => new Response("OggS original audio", {
      headers: { "Content-Type": contentType, "Content-Disposition": `inline; filename*=UTF-8''My%20recording.${extension}` },
    }));
    for (const type of [null, "VHS_LoadAudioUpload"]) {
      const h = harness(type, materialize);
      const received = [];
      const onDragDrop = async event => {
        const file = event.dataTransfer.files[0];
        if (!event.dataTransfer.types.includes("Files") || file.type !== contentType) return false;
        received.push(file);
        return true;
      };
      if (h.node) h.node.onDragDrop = onDragDrop;
      else {
        const createNode = h.liteGraph.createNode;
        h.liteGraph.createNode = type => ({ ...createNode(type), onDragDrop });
      }
      await h.transfer.drop({ kind: "audio", url: "/audio", filename: "My recording.ogg" }, [0, 0]);
      assert.equal(h.graph._nodes.length, 1);
      assert.equal(received[0].name, `pw-My recording.${extension}`);
      assert.equal(await received[0].text(), "OggS original audio");
    }
  }
});

test("upload names decode server metadata safely; missing metadata requests a restart", async () => {
  const materialize = createMediaMaterializer(async () => new Response("image", {
    headers: { "Content-Type": "image/png", "Content-Disposition": "inline; filename*=UTF-8''C%3A%5Cphotos%5CMy%3A%20image%3F.png" },
  }));
  assert.equal((await materialize({})).name, "pw-My_ image_.png");
  const stale = createMediaMaterializer(async () => new Response("image"));
  await assert.rejects(stale({}), /Restart ComfyUI/);
});

test("file drop events contain Files only and cannot bubble to workflow importers", t => {
  const window = new Window();
  const originals = { DataTransfer: globalThis.DataTransfer, DragEvent: globalThis.DragEvent };
  // happy-dom's DragEvent does not implement the dataTransfer constructor member.
  class FileDragEvent extends window.MouseEvent {
    constructor(type, options) {
      super(type, options);
      this.dataTransfer = options.dataTransfer;
    }
  }
  Object.assign(globalThis, { DataTransfer: window.DataTransfer, DragEvent: FileDragEvent });
  t.after(() => Object.assign(globalThis, originals));
  const element = window.document.createElement("canvas");
  const file = new window.File(["original"], "example.png", { type: "image/png" });
  const event = createFileDropEvent(file, [12, 34], element);
  assert.equal(event.dataTransfer.files[0], file);
  assert.equal(event.dataTransfer.files.length, 1);
  assert.equal(event.dataTransfer.getData("text/uri-list"), "");
  assert.equal(event.target, element);
  assert.equal(event.bubbles, false);
  assert.equal(event.clientX, 12);
});

test("panel remains non-modal and bounded; transfer code never invokes a workflow importer", async () => {
  const panel = await readFile(new URL("../web/floating_media.js", import.meta.url), "utf8");
  const source = await readFile(new URL("../web/workflow_media.js", import.meta.url), "utf8");
  assert.match(panel, /application\/x-h3ps-workflow-media/);
  assert.match(panel, /stopImmediatePropagation/);
  assert.doesNotMatch(panel, /aria-modal|backdrop/);
  assert.doesNotMatch(source, /dispatchEvent|handleFile|loadGraphData|updateParameters|VHS_/);
  assert.deepEqual(clampPanelPosition({ x: 999, y: -20 }, { width: 800, height: 600 }, { width: 410, height: 200 }), { x: 382, y: 8 });
});
