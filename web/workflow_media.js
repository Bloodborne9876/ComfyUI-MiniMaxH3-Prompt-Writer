const DEFAULT_LOADERS = { image: "LoadImage", video: "LoadVideo", audio: "LoadAudio" };

export function workflowMediaSnapshot(asset) {
  if (!asset || !DEFAULT_LOADERS[asset.type] || !asset.content_url) return null;
  const query = new URLSearchParams({
    session_id: asset.session_id,
    kind: "workflow",
    revision: String(asset.content_revision ?? asset.sample_index ?? 0),
  });
  return {
    id: asset.id, kind: asset.type, filename: asset.filename,
    url: `/h3studio/media/${encodeURIComponent(asset.id)}/content?${query}`,
  };
}

export function clampPanelPosition(position, viewport, size) {
  return {
    x: Math.max(8, Math.min(Number(position?.x) || 8, Math.max(8, viewport.width - size.width - 8))),
    y: Math.max(8, Math.min(Number(position?.y) || 8, Math.max(8, viewport.height - size.height - 8))),
  };
}

export function createMediaMaterializer(fetchApi) {
  return async function readFile(snapshot, signal) {
    const response = await fetchApi(snapshot.url, { signal });
    if (!response.ok) {
      throw new Error(response.status === 409
        ? "Media changed during drag. Drag the current version again."
        : "Could not read Writer media.");
    }
    const blob = await response.blob();
    // The server names the actual file, including format changes from applied edits.
    const encodedName = response.headers.get("Content-Disposition")?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
    if (!encodedName) throw new Error("Media file details are unavailable. Restart ComfyUI and refresh Writer.");
    const sourceName = decodeURIComponent(encodedName).split(/[\\/]/).pop();
    const filename = sourceName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[.\s]+$/, "");
    if (!filename) throw new Error("Media filename is unavailable.");
    signal?.throwIfAborted();
    // The receiver uploads once; ComfyUI reuses identical files and numbers name collisions.
    return new File([blob], `pw-${filename}`, { type: blob.type });
  };
}

export function createFileDropEvent(file, point, element) {
  const dataTransfer = new DataTransfer();
  dataTransfer.items.add(file);
  const event = new DragEvent("drop", {
    dataTransfer, clientX: point[0], clientY: point[1], cancelable: true,
  });
  Object.defineProperty(event, "target", { value: element });
  return event;
}

function fileReceiver(node) {
  if (node.isUploading || typeof node.onDragDrop !== "function") {
    throw new Error("Drop on a loader that accepts files and is not already uploading.");
  }
  return node.onDragDrop;
}

export function createWorkflowMediaTransfer({
  app, liteGraph, materialize,
  getWorkflowRevision = () => 0,
  isCurrentMedia = () => true,
  createDropEvent = createFileDropEvent,
}) {
  let active = null;

  function destination(kind, point, element = app.canvas?.canvas) {
    const canvas = app.canvas;
    const graph = canvas?.graph;
    if (!graph || canvas.read_only || canvas.allow_interaction === false) {
      throw new Error("Workflow is not editable.");
    }
    const position = app.clientPosToCanvasPos(point);
    if (position.length !== 2 || !position.every(Number.isFinite)) {
      throw new Error("Canvas position is unavailable.");
    }
    const node = graph.getNodeOnPos(...position);
    // Accept the node's DOM preview, but never mistake an unrelated overlay for empty canvas.
    if (element !== canvas.canvas && !node?.widgets?.some(widget => widget.element?.contains(element))) {
      throw new Error("Drop on the workflow canvas or a compatible media loader.");
    }
    const type = DEFAULT_LOADERS[kind];
    if (!type || (!node && !liteGraph.registered_node_types[type])) {
      throw new Error("The standard loader for this media is unavailable.");
    }
    return {
      graph, position, node, type,
      handler: node ? fileReceiver(node) : null,
      revision: getWorkflowRevision(), nodes: graph._nodes,
      widgetValues: node?.widgets?.map(widget => widget.value),
    };
  }

  async function drop(snapshot, point, signal, element = app.canvas?.canvas) {
    signal?.throwIfAborted();
    if (active && (active.dispatched || !active.signal?.aborted)) {
      throw new Error("Finish the current media transfer first.");
    }
    const target = destination(snapshot.kind, point, element);
    const job = { signal, dispatched: false };
    active = job;
    let created = null;

    function validate() {
      signal?.throwIfAborted();
      if (active !== job || getWorkflowRevision() !== target.revision || app.canvas?.graph !== target.graph
        || target.graph._nodes !== target.nodes || app.canvas.read_only || app.canvas.allow_interaction === false) {
        throw new Error("Workflow changed during transfer. Drop again.");
      }
      if (!isCurrentMedia(snapshot)) {
        throw new Error("Media changed during drag. Drag the current version again.");
      }
      if (target.node && (target.graph.getNodeById(target.node.id) !== target.node
        || fileReceiver(target.node) !== target.handler
        || target.node.widgets?.some((widget, index) => widget.value !== target.widgetValues[index]))) {
        throw new Error("The target loader changed during transfer. Drop again.");
      }
    }

    try {
      const file = await materialize(snapshot, signal);
      validate();
      const receiver = target.node || liteGraph.createNode(target.type);
      if (!receiver) throw new Error("ComfyUI could not create this media loader.");
      let handler;
      try {
        handler = fileReceiver(receiver);
      } catch (error) {
        if (!target.node) receiver.onRemoved?.();
        throw error;
      }
      const event = createDropEvent(file, point, element);
      target.graph.beforeChange?.();
      try {
        if (!target.node) {
          receiver.pos = [...target.position];
          created = receiver;
          target.graph.add(receiver);
        }
        job.dispatched = true;
        // Do not dispatch on document/canvas: PNG workflow metadata must never reach its importer.
        const accepted = await handler.call(receiver, event);
        if (accepted === false) throw new Error("This loader did not accept the file. Use a compatible media loader.");
        return receiver;
      } catch (error) {
        // A third-party receiver owns its upload and error recovery. Only remove our unused node.
        if (created && app.canvas?.graph === target.graph && target.graph.getNodeById(created.id) === created
          && !created.outputs?.some(output => output.links?.length)) {
          target.graph.remove(created);
        }
        throw error;
      } finally {
        target.graph.afterChange?.();
        target.graph.setDirtyCanvas(true, true);
      }
    } finally {
      if (active === job) active = null;
    }
  }

  return { destination, drop };
}
