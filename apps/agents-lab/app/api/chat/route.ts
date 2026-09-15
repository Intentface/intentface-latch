import { createUIMessageStreamResponse, type UIMessage } from "ai";
import { runAgentLoop, ExtensionFailedError } from "@intentface/agents-sdk";
import { ChatBusyError, NotYoursError } from "@intentface/agents-sdk/sqlite";
import { INSTRUCTIONS, extensionsFor, model, tools } from "@/lib/agent";
import { currentPrincipal } from "@/lib/principal";

export const maxDuration = 60;

export async function POST(req: Request) {
  const principal = await currentPrincipal();
  if (!principal) return new Response("Sign in first.", { status: 401 });

  const { messages, chatId } = (await req.json()) as { messages: UIMessage[]; chatId: string };
  if (!chatId) return new Response("chatId required", { status: 400 });

  try {
    // Everything that can fail happens before the stream exists, so a refusal
    // is a status code rather than a stream that opens and then apologises.
    const stream = await runAgentLoop({
      model,
      tools,
      messages,
      principal,
      instructions: INSTRUCTIONS,
      maxSteps: 10,
      extensions: extensionsFor(chatId, principal),
    });
    return createUIMessageStreamResponse({ stream });
  } catch (error) {
    if (error instanceof ExtensionFailedError) {
      if (error.cause instanceof NotYoursError)
        return new Response("That conversation belongs to another organization.", { status: 403 });
      if (error.cause instanceof ChatBusyError)
        return new Response("This conversation is already running somewhere else.", { status: 409 });
    }
    console.error("[chat] run failed to start", error);
    return new Response("Could not start the run.", { status: 500 });
  }
}
