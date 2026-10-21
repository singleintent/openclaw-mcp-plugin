---
name: record-work-items
description: "Use when starting, handing off, blocking or finishing real work in a SingleIntent project: record focus and task items, dispatch/ack, size, and state changes through the SingleIntent MCP tools."
---

# Record work items

Record real work as it happens so a user can follow each AI focus as clear tasks. Write only through the SingleIntent MCP tools (`create_workitem`, `workitem_set_state`, `workitem_estimate`); never edit the work-item store or ledger files.

## Steps

1. **Find the focus.** Run `list_workitems` for the project. Reuse the open focus item for this line of work. Only when none fits, create one with `create_workitem` and `kind: "focus"`, a short title and an intent naming the goal. Done when you have the focus item's id.
2. **Create one task per discrete piece of work.** Use `create_workitem` with `focus` (step 1's id), `assignee` (the agent who will do it, including yourself), `estimate` (XS ≤30m, S ≤2h, M ≤1d, L ≤3d, XL >3d) and an `eventId`. Reuse that `eventId` if you retry. Set `test: true` only for test or demo records. Done when the item id is returned.
3. **Hand off.** When someone else will do the task, record `dispatched` on it and tell them the item id. Skip steps 3–4 when you do the task yourself. Done when the dispatch event is on the item.
4. **Pick up.** When an item is dispatched to you, record `acknowledged` straight away. Only the assignee can do this. Done when the ack event shows you as actor.
5. **Start.** Record `started` when work actually begins, not when it is planned. Start within 15 minutes of acknowledging; if you cannot, record `blocked` with the reason instead of leaving the item idle. Done when the item reads `started` or `blocked`.
6. **Block.** If you cannot proceed, record `blocked` with a reason naming who or what you are waiting on. Record `started` again when it clears. Done when the reason is on the item.
7. **Re-size.** If the work proves bigger or smaller than the estimate, run `workitem_estimate` with the new size. The original is kept. Done when the new size shows as the item's estimate.
8. **Finish.** Record `completed` with an outcome saying what changed, plus evidence such as a commit, test counts or a URL. For code, complete only once the commit is on origin/main, and cite that pushed hash. Until then the item stays `started`. Record `failed` or `canceled` with a reason when the work ends another way. Done when the item is terminal.

## Rules

- Record your own state. The server takes the actor from your token; never record a transition for another agent.
- Work done before its item existed: put the word "retroactive" in both the started reason and the evidence. Its timings are not real effort.
- A terminal item cannot be amended. Get the outcome right before completing.
- If a write is refused (401, 403, `no-agent-token`) or shows the wrong actor, report it as a defect to your manager. Do not work around it.
