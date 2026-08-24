import { RealtimeAvatar, RealtimeAvatarHttpError, isQueued } from "realtime-avatar";

const rta = new RealtimeAvatar({ apiKey: process.env.REALTIME_AVATAR_API_KEY! });

export async function POST(request: Request): Promise<Response> {
  const user = await currentUser(request);
  if (!user) return new Response("Unauthorized", { status: 401 });

  try {
    // The client picks nothing about the call. Everything here is your decision.
    const call = await rta.startCall({
      avatarId: process.env.REALTIME_AVATAR_ID!,
      mode: "voice",
      instructions: "You are Rin. Short, warm, specific sentences. Never mention being an AI.",
      maxSeconds: 120,                     // a forgotten tab cannot run up a bill
      metadata: { userId: user.id },
    });

    // Every slot busy. Not an error — the caller shows a position and retries.
    if (isQueued(call)) {
      return Response.json({ queued: true, position: call.position }, { status: 429 });
    }

    // Byte-for-byte. Wrapping or adding a key makes the client reject the whole thing.
    return Response.json(call.raw);
  } catch (err) {
    if (err instanceof RealtimeAvatarHttpError && err.isBilling) {
      return Response.json({ code: "insufficient_credits" }, { status: 402 });
    }
    throw err;
  }
}

declare function currentUser(request: Request): Promise<{ id: string } | null>;
