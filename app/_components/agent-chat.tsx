"use client";

import type { UserContent } from "ai";
import { useEveAgent } from "eve/react";
import { AlertCircleIcon, BrainIcon, MicIcon, PlusIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputButton,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AgentMessage } from "./agent-message";

const AGENT_NAME = "sam";

type VoiceRecognitionEvent = {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

type VoiceRecognitionErrorEvent = {
  error: string;
};

type VoiceRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onend: (() => void) | null;
  onerror: ((event: VoiceRecognitionErrorEvent) => void) | null;
  onresult: ((event: VoiceRecognitionEvent) => void) | null;
  onstart: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type VoiceRecognitionConstructor = new () => VoiceRecognition;

type VoiceWindow = Window &
  typeof globalThis & {
    SpeechRecognition?: VoiceRecognitionConstructor;
    webkitSpeechRecognition?: VoiceRecognitionConstructor;
  };

export function AgentChat({
  sessionId,
  sessionless = false,
}: {
  readonly sessionId?: string;
  readonly sessionless?: boolean;
}) {
  const [cancellationError, setCancellationError] = useState<string>();
  const [isListening, setIsListening] = useState(false);
  const [voiceMode, setVoiceMode] = useState(false);
  const recognitionRef = useRef<VoiceRecognition | null>(null);
  const voiceModeRef = useRef(false);
  const waitingForReplyRef = useRef(false);
  const lastSpokenMessageIdRef = useRef<string | undefined>(undefined);
  const agent = useEveAgent({
    initialSession:
      sessionId === undefined
        ? undefined
        : {
            sessionId,
            streamIndex: 0,
          },
    resume: sessionId !== undefined,
    onSessionChange(session) {
      if (sessionId === undefined && session !== undefined) {
        // Next patches window.history to navigate, which would detach the active stream.
        History.prototype.replaceState.call(
          window.history,
          window.history.state,
          "",
          `/s/${encodeURIComponent(session.sessionId)}`,
        );
      }
    },
  });

  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const isBusyRef = useRef(isBusy);
  isBusyRef.current = isBusy;
  const isRestoring = sessionId !== undefined && agent.events.length === 0 && isBusy;
  const isEmpty = agent.data.messages.length === 0;
  const lastMessage = agent.data.messages.at(-1);
  const isPendingAssistantShell =
    lastMessage?.role === "assistant" &&
    lastMessage.parts.every((part) => part.type === "step-start");
  const showPendingThinking =
    isBusy &&
    (agent.status === "submitted" || lastMessage?.role !== "assistant" || isPendingAssistantShell);
  const turnFailure = isBusy ? undefined : getLatestTurnFailure(agent.events);
  const errorMessage = cancellationError ?? agent.error?.message ?? turnFailure;
  const hasConversationContent = sessionless || !isEmpty || errorMessage !== undefined;
  const showConversationLayout = isRestoring || hasConversationContent;
  const activeSessionId = sessionId ?? agent.session?.sessionId;

  const requestCancellation = () => {
    setCancellationError(undefined);
    void agent.cancel().catch((error: unknown) => {
      setCancellationError(toErrorMessage(error));
    });
  };

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if ((text.length === 0 && message.files.length === 0) || isRestoring) return;

    setCancellationError(undefined);
    const options = isBusy ? { turnPolicy: "steer" as const } : undefined;

    if (message.files.length === 0) {
      await agent.send(text, options);
      return;
    }

    const parts: UserContent = [];
    if (text.length > 0) {
      parts.push({ text, type: "text" });
    }
    for (const file of message.files) {
      parts.push({
        data: file.url,
        filename: file.filename,
        mediaType: file.mediaType,
        type: "file",
      });
    }

    await agent.send(parts, options);
  };

  const stopVoiceMode = () => {
    voiceModeRef.current = false;
    waitingForReplyRef.current = false;
    setVoiceMode(false);
    setIsListening(false);
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    window.speechSynthesis?.cancel();
  };

  const startListening = () => {
    if (!voiceModeRef.current || recognitionRef.current || isBusyRef.current) return;

    const voiceWindow = window as VoiceWindow;
    const SpeechRecognition =
      voiceWindow.SpeechRecognition ?? voiceWindow.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      stopVoiceMode();
      alert("Voice recognition is not supported on this browser.");
      return;
    }

    const recognition = new SpeechRecognition();
    recognitionRef.current = recognition;
    recognition.lang = "en-CA";
    recognition.continuous = false;
    recognition.interimResults = false;

    let hadError = false;

    recognition.onstart = () => setIsListening(true);
    recognition.onerror = (event) => {
      hadError = true;
      setIsListening(false);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        stopVoiceMode();
      }
    };
    recognition.onresult = (event) => {
      const transcript = event.results[0]?.[0]?.transcript?.trim();
      if (!transcript) return;

      waitingForReplyRef.current = true;
      void handleSubmit({ text: transcript, files: [] }).catch(() => {
        waitingForReplyRef.current = false;
      });
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      setIsListening(false);

      if (
        voiceModeRef.current &&
        !waitingForReplyRef.current &&
        !isBusyRef.current &&
        !hadError
      ) {
        window.setTimeout(startListening, 350);
      }
    };

    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setIsListening(false);
    }
  };

  const toggleVoiceMode = () => {
    if (voiceModeRef.current) {
      stopVoiceMode();
      return;
    }

    voiceModeRef.current = true;
    setVoiceMode(true);

    // Unlock speech output during the user's first tap (required by mobile browsers).
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const unlock = new SpeechSynthesisUtterance(".");
      unlock.lang = "en-CA";
      unlock.volume = 0.01;
      window.speechSynthesis.speak(unlock);
    }

    startListening();
  };

  useEffect(() => {
    if (
      !voiceMode ||
      isBusy ||
      lastMessage?.role !== "assistant" ||
      lastSpokenMessageIdRef.current === lastMessage.id
    ) {
      return;
    }

    const text = lastMessage.parts
      .filter((part): part is typeof part & { text: string } => part.type === "text")
      .map((part) => part.text)
      .join(" ")
      .trim();

    if (!text) return;

    lastSpokenMessageIdRef.current = lastMessage.id;
    waitingForReplyRef.current = false;
    recognitionRef.current?.stop();
    recognitionRef.current = null;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "en-CA";
    utterance.rate = 0.95;
    utterance.onend = () => {
      if (voiceModeRef.current) window.setTimeout(startListening, 250);
    };
    utterance.onerror = () => {
      if (voiceModeRef.current) window.setTimeout(startListening, 250);
    };

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }, [isBusy, lastMessage, voiceMode]);

  useEffect(
    () => () => {
      voiceModeRef.current = false;
      recognitionRef.current?.stop();
      window.speechSynthesis?.cancel();
    },
    [],
  );

  const composer = (
    <PromptInput onSubmit={handleSubmit}>
      <PromptInputTextarea disabled={isRestoring} placeholder="Send a message…" />
      {isBusy && !isRestoring ? (
        <PromptInputButton
          aria-label="Stop"
          className="absolute right-12 bottom-2.5 rounded-full"
          onClick={requestCancellation}
          variant="default"
        >
          <SquareIcon className="size-3 fill-current" />
        </PromptInputButton>
      ) : null}
      <PromptInputButton
        aria-label={voiceMode ? "Turn off voice mode" : "Turn on voice mode"}
        className="absolute right-24 bottom-2.5 rounded-full"
        disabled={isRestoring}
        onClick={toggleVoiceMode}
        type="button"
        variant={voiceMode ? "default" : "ghost"}
      >
        <MicIcon className={isListening ? "size-4 animate-pulse" : "size-4"} />
      </PromptInputButton>
      <PromptInputSubmit disabled={isRestoring} status={isBusy ? undefined : agent.status} />
    </PromptInput>
  );

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      {showConversationLayout ? (
        <ChatHeader canStartNewChat={activeSessionId !== undefined} />
      ) : null}

      {showConversationLayout ? (
        <Conversation
          className="min-h-0 flex-1"
          initial={sessionId === undefined ? undefined : false}
          resize={activeSessionId === undefined ? "smooth" : "instant"}
          scrollRestorationKey={
            isEmpty || activeSessionId === undefined
              ? undefined
              : `eve:web-chat-scroll:${activeSessionId}`
          }
        >
          <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 pt-20 pb-36 sm:px-6">
            {agent.data.messages.map((message, index) =>
              showPendingThinking &&
              isPendingAssistantShell &&
              message.id === lastMessage.id ? null : (
                <AgentMessage
                  canRespond={!isBusy}
                  isStreaming={
                    agent.status === "streaming" && index === agent.data.messages.length - 1
                  }
                  key={message.id}
                  message={message}
                  onInputResponses={(inputResponses) => {
                    setCancellationError(undefined);
                    return agent.respond(inputResponses);
                  }}
                />
              ),
            )}
            {showPendingThinking ? <PendingThinking /> : null}
            {errorMessage ? <ErrorMessage message={errorMessage} /> : null}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      ) : null}

      <div
        className={cn(
          "mx-auto w-full px-4 sm:px-6",
          showConversationLayout
            ? "fixed bottom-0 left-1/2 z-20 max-w-3xl -translate-x-1/2 bg-gradient-to-t from-background via-background to-transparent pt-4 pb-6"
            : "flex max-w-xl flex-1 flex-col items-center justify-center gap-8 pb-[10vh]",
        )}
      >
        {showConversationLayout ? null : (
          <div className="flex flex-col items-center gap-3 text-center">
            <h1 className="font-medium text-5xl tracking-tighter">{AGENT_NAME}</h1>
          </div>
        )}
        <div className="w-full">{composer}</div>
      </div>
    </main>
  );
}

function ErrorMessage({ message }: { readonly message: string }) {
  return (
    <Message className="max-w-full" from="assistant">
      <MessageContent>
        <div
          className="flex w-full items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm"
          role="alert"
        >
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium">Request failed</p>
            <p className="mt-0.5 text-muted-foreground">{message}</p>
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}

function ChatHeader({ canStartNewChat }: { readonly canStartNewChat: boolean }) {
  return (
    <header className="pointer-events-none fixed top-0 right-0 left-0 z-20 h-14">
      <div className="relative mx-auto flex h-full w-full max-w-3xl items-center justify-center bg-background px-24">
        <span className="truncate text-muted-foreground text-sm">{AGENT_NAME}</span>
        {canStartNewChat ? (
          <Button
            aria-label="Start a new chat"
            className="pointer-events-auto fixed top-2 right-6"
            onClick={() => window.location.assign("/s")}
            size="sm"
            type="button"
            variant="ghost"
          >
            <PlusIcon className="size-4" />
            <span className="hidden sm:inline">New chat</span>
          </Button>
        ) : null}
      </div>
    </header>
  );
}

function PendingThinking() {
  return (
    <Message aria-live="polite" from="assistant">
      <MessageContent>
        <div className="mb-4 flex w-full items-center gap-2 text-muted-foreground text-sm">
          <BrainIcon className="size-4" />
          <Shimmer duration={1}>Thinking</Shimmer>
        </div>
      </MessageContent>
    </Message>
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to cancel the response.";
}

function getLatestTurnFailure(
  events: ReturnType<typeof useEveAgent>["events"],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event.type === "turn.failed") {
      return event.data.code === "MODEL_CALL_FAILED"
        ? "The model is temporarily unavailable. Please try again."
        : event.data.message;
    }

    if (event.type === "turn.completed" || event.type === "turn.cancelled") {
      return undefined;
    }

    if (event.type === "message.received") {
      return undefined;
    }
  }

  return undefined;
}
