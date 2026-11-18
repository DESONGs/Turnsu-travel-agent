---
name: travel-workspace
description: Open, plan and keep editing a trip in the shared Travel Agent MCP App.
---

Use the connected Travel Agent MCP tools. First list the user's workspaces or open the app. Use the user's named trip; if there are multiple plausible matches, ask which trip. Create a workspace only when starting a new trip, then retain its conversationId.

Call open_travel_workspace to show the shared app. Forward travel requirements to submit_travel_request with a stable requestId. It submits to the independent backend Travel Parent Agent, which owns evidence, planning, questions, validation and commits. Read get_travel_run for the actual outcome. Answer its pending question using answerTo and preserve the original objective. Reuse requestId after a network failure. Cancel only when the user requests it.

Use the current selected date, node, route and revision supplied by the app. Read saved state before describing something as adopted. Apply only the user's confirmed change; preserve unrelated plans and bookings. Never turn a map place into bookable inventory or call driving directions a taxi quote. Keep source and uncertainty visible.

Support any destination; the backend matches sources by region. Purchases, payments, automatic changes/cancellations and social writes are outside this plugin. Never request credentials, identity documents or payment details in chat.

When the open place preview sends a photograph and asks for a layered drawing, edit that specific photograph with the host’s own image-generation tool. Preserve its framing, geography, people and architecture. Apply the drawing technique supplied by the preview. Inspect the finished drawing, trace the visible foreground and middle-distance shapes in normalized image coordinates and return the generated file through return_destination_artwork with the supplied tripId and requestId. If the host cannot generate or return the file, call decline_destination_artwork. This request is ephemeral and does not change the trip or create a journal entry.

When a traveler asks to keep a dictated memory or an imported note, use their words to prepare a journal entry. Preserve the details, uncertainty and tone they supplied. Use the current trip and place when clear. Keep a supplied visit date, and leave it empty when unknown. A source photograph alone does not establish that the traveler visited, who was there or how it felt.

Call write_travel_memory with the current tripId, a stable entryId (UUID), the note and either the selected nodeId or the traveler's placeTitle. Retry with the same entryId. To edit a page, use list_my_travel_memories to find its current revision, then submit the complete edited note with that entryId and revision. If a concurrent edit conflicts, read the current page before combining changes. Only send the finished entry to the travel tool. The original recording or file stays with the host. A successful write is private to the author. Open the travel journal for review, and let the traveler select a postcard and its message for export.
