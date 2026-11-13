---
name: progress
description: Showing what an agent is doing during long tasks, so people trust it and can step in
---
# Showing progress

People stop trusting an agent they can't see working. They also can't correct
it.

- Show each step as it happens, in the user's words: "Checking Baltic Lines'
  capacity for Thursday", not "calling get_capacity".
- Keep finished steps visible but collapsed. The record of what was checked is
  the agent's evidence.
- For tasks over a minute, say what's left: "3 of 7 carriers checked".
- Let the user stop the task at any step, and say what was already done when
  they do.
- Never show a spinner with no text for more than two seconds.
