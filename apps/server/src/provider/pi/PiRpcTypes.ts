export type PiRpcCommand =
  | {
      readonly id?: string;
      readonly type: "prompt";
      readonly message: string;
      readonly images?: ReadonlyArray<unknown>;
    }
  | { readonly id?: string; readonly type: "abort" }
  | { readonly id?: string; readonly type: "new_session"; readonly parentSession?: string }
  | { readonly id?: string; readonly type: "get_state" }
  | {
      readonly id?: string;
      readonly type: "set_model";
      readonly provider: string;
      readonly modelId: string;
    }
  | { readonly id?: string; readonly type: "get_available_models" }
  | { readonly id?: string; readonly type: "get_messages" }
  | { readonly id?: string; readonly type: "get_commands" }
  | { readonly id?: string; readonly type: "get_last_assistant_text" }
  | { readonly id?: string; readonly type: "set_session_name"; readonly name: string }
  | { readonly id?: string; readonly type: "extension_ui_response"; readonly value: string }
  | { readonly id?: string; readonly type: "extension_ui_response"; readonly confirmed: boolean }
  | { readonly id?: string; readonly type: "extension_ui_response"; readonly cancelled: true };

export interface PiRpcResponseSuccess<T = unknown> {
  readonly id?: string;
  readonly type: "response";
  readonly command: string;
  readonly success: true;
  readonly data?: T;
}

export interface PiRpcResponseFailure {
  readonly id?: string;
  readonly type: "response";
  readonly command: string;
  readonly success: false;
  readonly error: string;
}

export type PiRpcResponse<T = unknown> = PiRpcResponseSuccess<T> | PiRpcResponseFailure;

export type PiExtensionUiRequest =
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "select";
      readonly title: string;
      readonly options: ReadonlyArray<string>;
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "confirm";
      readonly title: string;
      readonly message: string;
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "input";
      readonly title: string;
      readonly placeholder?: string;
      readonly timeout?: number;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "editor";
      readonly title: string;
      readonly prefill?: string;
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "notify";
      readonly message: string;
      readonly notifyType?: "info" | "warning" | "error";
    }
  | {
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method: "setStatus" | "setWidget" | "setTitle" | "set_editor_text";
      readonly [key: string]: unknown;
    };

export interface PiModelInfo {
  readonly provider?: string;
  readonly id: string;
  readonly contextWindow?: number;
  readonly reasoning?: boolean;
}

export interface PiSessionState {
  readonly sessionId: string;
  readonly sessionFile?: string;
  readonly sessionName?: string;
  readonly isStreaming: boolean;
  readonly model?: { readonly provider?: string; readonly id?: string };
  readonly thinkingLevel?: string;
  readonly messageCount?: number;
  readonly pendingMessageCount?: number;
}

export type PiRpcEvent =
  | PiRpcResponse
  | PiExtensionUiRequest
  | (Record<string, unknown> & { readonly type?: string });

export function isPiRpcResponse(value: unknown): value is PiRpcResponse {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { readonly type?: unknown }).type === "response" &&
    typeof (value as { readonly command?: unknown }).command === "string" &&
    typeof (value as { readonly success?: unknown }).success === "boolean"
  );
}

export function isPiExtensionUiRequest(value: unknown): value is PiExtensionUiRequest {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { readonly type?: unknown }).type === "extension_ui_request" &&
    typeof (value as { readonly id?: unknown }).id === "string" &&
    typeof (value as { readonly method?: unknown }).method === "string"
  );
}
