---
name: travel-workspace
description: Open and continuously edit the global Travel Agent workspace through its MCP App and Artifact adapter.
---

This plugin connects to the same Travel Agent MCP App and backend as the GPT plugin. List or create the user's workspace, preserve conversationId, and call open_travel_workspace. The shared app is the complete travel workbench; the backend Travel Parent Agent owns actual planning, evidence and commits.

For the native Artifact surface, use the bundled assets/artifact.html or get_travel_artifact. Create or reopen ONE private Artifact. Preserve its reference when continuing in another conversation. Use the host's actual, authorized connector runtime to bind globalThis.TRAVEL_ARTIFACT_CONNECTOR before starting the application. The binding contract is:

    callTool(name, arguments) -> Promise<MCP CallToolResult or structured JSON>
    initialize?(), updateContext?(context), sendMessage?(text), openLink?(url), onResult?(listener)

callTool must call this viewer's Travel Agent connector, including travel_app_action. Credentials belong to the host connection. Never embed them in the Artifact. Use the runtime's real connector API; do not invent a window.claude method. If the native Artifact runtime cannot supply this binding, report that surface as unavailable and keep the functioning MCP App available. Do not present a static summary as the complete Artifact application.

Forward planning requests through submit_travel_request with conversationId and a stable requestId, then read get_travel_run. Continue necessary questions with answerTo. Reuse saved workspaces and task IDs after disconnecting. User clicks and chat edits use the same backend operations, revision checks and confirmation gates.

Match source coverage by destination. Map places do not establish live room rates, tickets or continuous accessibility. Never purchase, pay, cancel bookings automatically, perform social writes or collect identity/payment credentials.

When the open place preview sends a photograph and asks for a layered drawing, edit that specific photograph with the host’s own image-generation tool. Preserve its framing, geography, people and architecture. Apply the drawing technique supplied by the preview. Inspect the finished drawing, trace the visible foreground and middle-distance shapes in normalized image coordinates and return the generated file through return_destination_artwork with the supplied tripId and requestId. If the host cannot generate or return the file, call decline_destination_artwork. This request is ephemeral and does not change the trip or create a journal entry.

An Artifact host with a native image editor can expose generateDestinationArtwork({image, prompt, depthInstructions}, signal) on its connector. Return {image: {type: "image", mimeType, data}, shapes: [{depth, points}]} with the actual generated raster and its silhouettes. Omit the method if the host cannot fulfill it.

When a traveler asks to keep a dictated memory or an imported note, use their words to prepare a journal entry. Preserve the details, uncertainty and tone they supplied. Use the current trip and place when clear. Keep a supplied visit date, and leave it empty when unknown. A source photograph alone does not establish that the traveler visited, who was there or how it felt.

Call write_travel_memory with the current tripId, a stable entryId (UUID), the note and either the selected nodeId or the traveler's placeTitle. Retry with the same entryId. To edit a page, use list_my_travel_memories to find its current revision, then submit the complete edited note with that entryId and revision. If a concurrent edit conflicts, read the current page before combining changes. Only send the finished entry to the travel tool. The original recording or file stays with the host. A successful write is private to the author. Open the travel journal for review, and let the traveler select a postcard and its message for export.
