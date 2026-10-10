---
"@intentface/latch-core": minor
---

New `ToolContext<Principal, Ctx>` type: what a tool receives as `options.context` during a run. That's whatever your `defineContext` `build` returned, plus `principal`, `run` (`id`, `chatId`, `agent`), `writer` and `runtime`, which Latch adds for every tool. Use it instead of declaring those fields by hand:

```ts
execute: async ({ orderId }, { context }) => {
  const { orders, principal } = context as ToolContext<Principal, Ctx>;
  return orders.refund(orderId, principal.userId);
},
```
