import type {
  CapacityBusyResponse,
  LiveKitCapacitySnapshot,
  LiveKitInitialContextMessage,
  LiveKitSessionGrant,
  LiveKitSessionRequestInput,
  LiveKitSessionWireRequestInput,
  LiveKitSttMode,
  LLMProvider,
  LLMSelectionForProvider,
} from "./wire";
import { toLiveKitSessionWireRequest as toContractLiveKitSessionWireRequest } from "./wire";
import type { VoiceSpecInput } from "./types";

export type {
  CapacityBusyResponse,
  ClientMetadata,
  LiveKitCapacitySnapshot,
  LiveKitInitialContextMessage,
  LiveKitSessionGrant,
  LiveKitSttMode,
  RenderBackend,
  TranscriptWebhook,
} from "./wire";

export type LiveKitSessionRequest<
  TLlmProvider extends LLMProvider = LLMProvider,
> = Omit<LiveKitSessionRequestInput, "llm" | "voice"> & {
  llm?: LLMSelectionForProvider<TLlmProvider> | null;
  // The INPUT voice type — an explicit `provider` (cartesia | breezeblue | fish)
  // is required. The legacy provider-less shim that defaulted to the self-hosted
  // qwen arm was removed in the Qwen TTS teardown; there is no implicit provider.
  voice?: VoiceSpecInput | null;
};

/** Maps the ergonomic SDK request to the snake_case platform contract. */
export function toLiveKitSessionWireRequest<TLlmProvider extends LLMProvider>(
  input: LiveKitSessionRequest<TLlmProvider>,
): LiveKitSessionWireRequestInput {
  return toContractLiveKitSessionWireRequest(input);
}
