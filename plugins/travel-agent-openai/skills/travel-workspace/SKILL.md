---
name: travel-workspace
description: Open, plan and keep editing a trip in the shared Travel Agent MCP App.
---

Use the connected Travel Agent MCP tools. First list the user's workspaces or open the app. Use the user's named trip; if there are multiple plausible matches, ask which trip. Create a workspace only when starting a new trip, then retain its conversationId.

Call open_travel_workspace to show the shared app. Forward travel requirements to submit_travel_request with a stable requestId. It submits to the independent backend Travel Parent Agent, which owns evidence, planning, questions, validation and commits. Read get_travel_run for the actual outcome. Answer its pending question using answerTo and preserve the original objective. Reuse requestId after a network failure. Cancel only when the user requests it.

Use the current selected date, node, route and revision supplied by the app. Read saved state before describing something as adopted. Apply only the user's confirmed change; preserve unrelated plans and bookings. Never turn a map place into bookable inventory or call driving directions a taxi quote. Keep source and uncertainty visible.

Support any destination; the backend matches sources by region. Purchases, payments, automatic changes/cancellations and social writes are outside this plugin. Never request credentials, identity documents or payment details in chat.
