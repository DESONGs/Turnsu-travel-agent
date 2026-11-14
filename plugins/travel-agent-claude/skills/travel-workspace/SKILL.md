---
name: travel-workspace
description: Open and continuously edit the global Travel Agent workspace through its MCP App and Artifact adapter.
---

This plugin connects to the same Travel Agent MCP App and backend as the GPT plugin. List or create the user's workspace, preserve conversationId, and call open_travel_workspace. The shared app is the complete travel workbench; the backend Travel Parent Agent owns actual planning, evidence and commits.

Prefer the standard interactive MCP App. Claude supports interactive connectors with inline, panel and fullscreen views; actual availability depends on the account/client. Never invent a connector binding.

For an explicitly requested native Artifact surface, use the bundled assets/artifact.html or get_travel_artifact. Create or reopen ONE private Artifact. Preserve its reference when continuing in another conversation. Use the host's actual, authorized connector runtime to bind globalThis.TRAVEL_ARTIFACT_CONNECTOR before starting the application. The binding contract is:

    callTool(name, arguments) -> Promise<MCP CallToolResult or structured JSON>
    initialize?(), updateContext?(context), sendMessage?(text), openLink?(url), onResult?(listener)

callTool must call this viewer's Travel Agent connector, including travel_app_action. Credentials belong to the host connection. Never embed them in the Artifact. Use the runtime's real connector API; do not invent a window.claude method. If the native Artifact runtime cannot supply this binding, report that surface as unavailable and keep the functioning MCP App available. Do not present a static summary as the complete Artifact application.

Forward planning requests through submit_travel_request with conversationId and a stable requestId, then read get_travel_run. Continue necessary questions with answerTo. Reuse saved workspaces and task IDs after disconnecting. User clicks and chat edits use the same backend operations, revision checks and confirmation gates.

Match source coverage by destination. Map places do not establish live room rates, tickets or continuous accessibility. Never purchase, pay, cancel bookings automatically, perform social writes or collect identity/payment credentials.
