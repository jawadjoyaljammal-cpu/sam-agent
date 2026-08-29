"use client";

import type { UserContent } from "ai";
import { ClientError } from "eve/client";
import { useEveAgent } from "eve/react";
import {
  AlertCircleIcon,
  BrainIcon,
  CameraIcon,
  MicIcon,
  PaperclipIcon,
  PlusIcon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputButton,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AgentMessage } from "./agent-message";

const AGENT_NAME = "sam";
const LAST_SESSION_STORAGE_KEY = "sam:last-session-id";

const VOICE_LANGUAGES = {
  ar: { label: "AR", locale: "ar-LB", name: "العربية اللبنانية" },
  en: { label: "EN", locale: "en-CA", name: "English" },
  fr: { label: "FR", locale: "fr-CA", name: "Français" },
} as const;

type VoiceLanguage = keyof typeof VOICE_LANGUAGES;

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
  const [voiceLanguage, setVoiceLanguage] = useState<VoiceLanguage>("ar");
  const recognitionRef = useRef<VoiceRecognition | null>(null);
  const voiceModeRef = useRef(false);
  const voiceLanguageRef = useRef<VoiceLanguage>("ar");
  const waitingForReplyRef = useRef(false);
  const isSpeakingRef = useRef(false);
  const restartTimerRef = useRef<number | null>(null);
  const lastSpokenMessageIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (sessionId !== undefined) {
      window.localStorage.setItem(LAST_SESSION_STORAGE_KEY, sessionId);
      return;
    }

    if (sessionless) return;

    const savedSessionId = window.localStorage.getItem(LAST_SESSION_STORAGE_KEY);
    if (savedSessionId) {
      window.location.replace(`/s/${encodeURIComponent(savedSessionId)}`);
    }
  }, [sessionId, sessionless]);

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
      if (session !== undefined) {
        window.localStorage.setItem(LAST_SESSION_STORAGE_KEY, session.sessionId);
      }
      if (session !== undefined && session.sessionId !== sessionId) {
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

    let content: string | UserContent = text;
    if (message.files.length > 0) {
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
      content = parts;
    }

    try {
      await agent.send(content, options);
    } catch (error) {
      if (!(error instanceof ClientError) || error.code !== "session_not_active") {
        throw error;
      }

      // An expired durable session cannot accept another turn. Detach it locally,
      // forget the stale saved ID, and resend once to create a fresh session.
      window.localStorage.removeItem(LAST_SESSION_STORAGE_KEY);
      agent.reset();
      await agent.send(content);
    }
  };

  const stopVoiceMode = () => {
    voiceModeRef.current = false;
    waitingForReplyRef.current = false;
    isSpeakingRef.current = false;
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
    setVoiceMode(false);
    setIsListening(false);
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    window.speechSynthesis?.cancel();
  };

  const startListening = () => {
    if (
      !voiceModeRef.current ||
      recognitionRef.current ||
      isBusyRef.current ||
      isSpeakingRef.current
    ) {
      return;
    }

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
    recognition.lang = VOICE_LANGUAGES[voiceLanguageRef.current].locale;
    recognition.continuous = false;
    recognition.interimResults = false;

    let shouldRestart = true;

    recognition.onstart = () => setIsListening(true);
    recognition.onerror = (event) => {
      setIsListening(false);
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        shouldRestart = false;
        stopVoiceMode();
        alert("اسمح لـ Sam باستخدام الميكروفون من إعدادات Safari، ثم اضغط زر الميكروفون مرة واحدة.");
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
        !isSpeakingRef.current &&
        shouldRestart
      ) {
        restartTimerRef.current = window.setTimeout(() => {
          restartTimerRef.current = null;
          startListening();
        }, 500);
      }
    };

    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setIsListening(false);
    }
  };

  const cycleVoiceLanguage = () => {
    const languageOrder: VoiceLanguage[] = ["en", "ar", "fr"];
    const currentIndex = languageOrder.indexOf(voiceLanguageRef.current);
    const nextLanguage = languageOrder[(currentIndex + 1) % languageOrder.length] ?? "en";
    const activeRecognition = recognitionRef.current;

    voiceLanguageRef.current = nextLanguage;
    setVoiceLanguage(nextLanguage);

    if (activeRecognition) {
      activeRecognition.stop();
    } else if (voiceModeRef.current && !isBusyRef.current) {
      window.setTimeout(startListening, 150);
    }
  };

  const toggleVoiceMode = () => {
    if (voiceModeRef.current) {
      stopVoiceMode();
      return;
    }

    voiceModeRef.current = true;
    setVoiceMode(true);

    // Start recognition directly inside the tap event. Playing a silent utterance
    // first can take over the iPhone audio session and make the first tap appear
    // to do nothing.
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
    isSpeakingRef.current = true;
    recognitionRef.current?.stop();
    recognitionRef.current = null;

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = VOICE_LANGUAGES[voiceLanguageRef.current].locale;
    utterance.rate = 0.95;
    utterance.onend = () => {
      isSpeakingRef.current = false;
      if (voiceModeRef.current) window.setTimeout(startListening, 350);
    };
    utterance.onerror = () => {
      isSpeakingRef.current = false;
      if (voiceModeRef.current) window.setTimeout(startListening, 350);
    };

    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }, [isBusy, lastMessage, voiceMode]);

  useEffect(
    () => () => {
      voiceModeRef.current = false;
      isSpeakingRef.current = false;
      if (restartTimerRef.current !== null) {
        window.clearTimeout(restartTimerRef.current);
      }
      recognitionRef.current?.stop();
      window.speechSynthesis?.cancel();
    },
    [],
  );

  const composer = (
    <PromptInput
      accept="image/*,.pdf,.doc,.docx,.txt,.csv,.xlsx"
      maxFileSize={10 * 1024 * 1024}
      maxFiles={5}
      multiple
      onError={({ message }) => alert(message)}
      onSubmit={handleSubmit}
    >
      <PromptInputTextarea
        className="pl-24"
        disabled={isRestoring}
        placeholder="Send a message…"
      />
      <PromptInputActionMenu>
        <PromptInputActionMenuTrigger
          aria-label="Add camera photo or file"
          className="absolute bottom-2.5 left-2.5 rounded-full"
          disabled={isRestoring}
          tooltip="Camera, photos, or files"
        >
          <PaperclipIcon className="size-5" />
        </PromptInputActionMenuTrigger>
        <PromptInputActionMenuContent>
          <PromptInputActionAddAttachments label="Camera, photos, or files" />
        </PromptInputActionMenuContent>
      </PromptInputActionMenu>
      <CameraAttachmentButton disabled={isRestoring} />
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
        aria-label={`Voice language: ${VOICE_LANGUAGES[voiceLanguage].name}. Tap to change.`}
        className="absolute right-36 bottom-2.5 min-w-9 rounded-full px-2 font-semibold text-xs"
        disabled={isRestoring}
        onClick={cycleVoiceLanguage}
        title={VOICE_LANGUAGES[voiceLanguage].name}
        type="button"
        variant="ghost"
      >
        {VOICE_LANGUAGES[voiceLanguage].label}
      </PromptInputButton>
      <PromptInputButton
        aria-label={voiceMode ? "Turn off voice mode" : "Turn on voice mode"}
        className="absolute right-24 bottom-1.5 size-11 touch-manipulation rounded-full"
        disabled={isRestoring}
        onClick={toggleVoiceMode}
        type="button"
        variant={voiceMode ? "default" : "ghost"}
      >
        <MicIcon className={isListening ? "size-5 animate-pulse" : "size-5"} />
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

function CameraAttachmentButton({ disabled }: { readonly disabled: boolean }) {
  const attachments = usePromptInputAttachments();
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <>
      <input
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(event) => {
          const files = event.currentTarget.files;
          if (files && files.length > 0) attachments.add(files);
          event.currentTarget.value = "";
        }}
        ref={inputRef}
        type="file"
      />
      <PromptInputButton
        aria-label="Take a photo"
        className="absolute bottom-2.5 left-12 rounded-full"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        tooltip="Take a photo"
        type="button"
      >
        <CameraIcon className="size-5" />
      </PromptInputButton>
    </>
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
