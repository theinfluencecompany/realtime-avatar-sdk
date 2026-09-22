import assert from "node:assert/strict";
import { test } from "node:test";
import { setupChat } from "@livekit/components-core";
import { Room, RoomEvent, type SendTextOptions, type TextStreamInfo, type TextStreamReader } from "livekit-client";
import { filter, firstValueFrom } from "rxjs";

// Exercise the installed LiveKit chat sender and receiver used by useChat. The
// network boundary is controlled; no inference Worker participates in this path.
test("LiveKit chat text streams preserve each input's attributes for the room consumer", async (t) => {
  const senderRoom = new Room();
  const receiverRoom = new Room();
  let receiveText: Parameters<Room["registerTextStreamHandler"]>[1] | undefined;
  let sequence = 0;
  const legacy: Record<string, unknown>[] = [];
  t.mock.method(receiverRoom, "registerTextStreamHandler", (topic: string, handler: Parameters<Room["registerTextStreamHandler"]>[1]) => {
    assert.equal(topic, "lk.chat");
    receiveText = handler;
  });
  t.mock.method(senderRoom.localParticipant, "publishData", async (bytes: Uint8Array) => {
    legacy.push(JSON.parse(new TextDecoder().decode(bytes)));
  });
  t.mock.method(senderRoom.localParticipant, "sendText", async (text: string, options: SendTextOptions = {}) => {
    assert.equal(options.topic, "lk.chat");
    assert.ok(receiveText);
    const info: TextStreamInfo = {
      id: `stream-${++sequence}`, topic: options.topic, mimeType: "text/plain",
      timestamp: Date.now(), encryptionType: 0, attributes: { ...options.attributes },
    };
    // This controlled stream models the public reader interface consumed by
    // setupChat, including partial chunks. It does not simulate WebRTC delivery.
    const reader = {
      info,
      async readAll() { return text; },
      async *[Symbol.asyncIterator]() { yield text.slice(0, 2); yield text.slice(2); },
    } as unknown as TextStreamReader;
    receiveText(reader, { identity: "user-one" });
    return info;
  });
  const sender = setupChat(senderRoom);
  const receiver = setupChat(receiverRoom);
  const received = firstValueFrom(receiver.messageObservable.pipe(
    filter((messages) => messages.length === 2 && messages.every((message) => message.message === "same words")),
  ));
  const defaults = {
    "rta.input_source_version": "1", "rta.observed_input_source": "text",
    "rta.turn_id": "turn-one",
  };
  const declaration = {
    ...defaults, "rta.turn_id": "turn-two",
    "rta.declared_input_source": "client_stt", "rta.input_source_declaration_scope": "adapter",
  };
  try {
    await Promise.all([
      sender.send("same words", { attributes: defaults }),
      sender.send("same words", { attributes: declaration }),
    ]);
    const messages = await received;
    const byId = new Map(messages.map((message) => [message.id, message.attributes]));
    assert.deepEqual(byId.get("stream-1"), defaults);
    assert.deepEqual(byId.get("stream-2"), declaration);
    assert.equal(legacy.length, 2);
    assert.ok(legacy.every((message) => !("attributes" in message)), "the documented legacy compatibility path does not carry attribution");
  } finally {
    senderRoom.emit(RoomEvent.Disconnected);
    receiverRoom.emit(RoomEvent.Disconnected);
  }
});
