"use client";

import { useState, useRef, useEffect } from "react";
import { format } from "date-fns";
import {
  PhoneIncoming,
  PhoneOutgoing,
  PhoneMissed,
  Play,
  Pause,
  Download,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { SMSCallLog } from "@/services/sms-service";
import apiClient from "@/lib/api-client";

interface SMSCallLogCardProps {
  call: SMSCallLog;
}

export function SMSCallLogCard({ call }: SMSCallLogCardProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [audioError, setAudioError] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (!call.recording_url || audioBlobUrl) return;

    let cancelled = false;
    const fetchRecording = async () => {
      setLoadingAudio(true);
      setAudioError(false);
      try {
        const response = await apiClient.get(`/voice/calls/${call.id}/recording`, {
          responseType: "blob",
        });
        if (cancelled) return;
        const blob = new Blob([response.data], { type: "audio/wav" });
        const url = URL.createObjectURL(blob);
        setAudioBlobUrl(url);
      } catch (err) {
        console.error("Failed to load call recording:", err);
        if (!cancelled) setAudioError(true);
      } finally {
        if (!cancelled) setLoadingAudio(false);
      }
    };

    void fetchRecording();
    return () => {
      cancelled = true;
    };
  }, [call.id, call.recording_url, audioBlobUrl]);

  useEffect(() => {
    return () => {
      if (audioBlobUrl) URL.revokeObjectURL(audioBlobUrl);
    };
  }, [audioBlobUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !audioBlobUrl) return;

    const handleTimeUpdate = () => {
      if (audio.duration && isFinite(audio.duration)) {
        setProgress((audio.currentTime / audio.duration) * 100);
        setCurrentTime(audio.currentTime);
      }
    };

    const handleEnded = () => {
      setIsPlaying(false);
      setProgress(0);
      setCurrentTime(0);
    };

    audio.addEventListener("ended", handleEnded);
    audio.addEventListener("timeupdate", handleTimeUpdate);

    return () => {
      audio.removeEventListener("ended", handleEnded);
      audio.removeEventListener("timeupdate", handleTimeUpdate);
    };
  }, [audioBlobUrl]);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  const isMissed = ["no-answer", "failed", "canceled"].includes(call.status);
  const isInbound = call.direction === "inbound";

  const getCallIcon = () => {
    if (isMissed) return <PhoneMissed className="h-4 w-4" />;
    if (isInbound) return <PhoneIncoming className="h-4 w-4" />;
    return <PhoneOutgoing className="h-4 w-4" />;
  };

  const getCallTitle = () => {
    if (call.status === "no-answer") return isInbound ? "Missed incoming call" : "Outgoing call (No answer)";
    if (call.status === "failed") return isInbound ? "Failed incoming call" : "Failed outgoing call";
    if (call.status === "canceled") return isInbound ? "Canceled incoming call" : "Canceled outgoing call";
    if (call.status === "busy") return isInbound ? "Missed call (Busy)" : "Outgoing call (Busy)";
    return isInbound ? "Incoming call" : "Outgoing call";
  };

  const togglePlayback = async () => {
    if (!audioRef.current || !audioBlobUrl) return;
    if (isPlaying) {
      audioRef.current.pause();
      setIsPlaying(false);
    } else {
      try {
        await audioRef.current.play();
        setIsPlaying(true);
      } catch (err) {
        console.error("Call recording playback failed:", err);
      }
    }
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!audioRef.current || !audioBlobUrl) return;
    const audio = audioRef.current;
    if (!audio.duration || !isFinite(audio.duration)) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    audio.currentTime = percent * audio.duration;
  };

  const handleDownload = async () => {
    if (!audioBlobUrl && !call.recording_url) return;
    try {
      let downloadUrl = audioBlobUrl;
      if (!downloadUrl) {
        const response = await apiClient.get(`/voice/calls/${call.id}/recording`, {
          responseType: "blob",
        });
        const blob = new Blob([response.data], { type: "audio/wav" });
        downloadUrl = URL.createObjectURL(blob);
      }
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = `call-recording-${call.id}.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      if (!audioBlobUrl && downloadUrl) {
        URL.revokeObjectURL(downloadUrl);
      }
    } catch (error) {
      console.error("Download failed:", error);
    }
  };

  const duration = call.recording_duration_seconds || call.duration_seconds || 0;
  const displayTime = isPlaying || progress > 0 ? currentTime : duration;

  return (
    <div className={cn("flex py-0.5", isInbound ? "justify-start" : "justify-end")}>
      <div
        className={cn(
          "rounded-2xl border px-3.5 py-2.5 min-w-[250px] max-w-[360px] w-full shadow-xs",
          isInbound ? "rounded-bl-sm" : "rounded-br-sm",
          isMissed
            ? "border-destructive/30 bg-destructive/5"
            : isInbound
              ? "border-border bg-muted/60"
              : "border-primary/20 bg-primary/5"
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 text-sm font-medium",
              isMissed
                ? "text-destructive"
                : isInbound
                  ? "text-emerald-600 dark:text-emerald-400"
                  : "text-primary"
            )}
          >
            {getCallIcon()}
            {getCallTitle()}
          </span>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground shrink-0">
            <span>{format(new Date(call.started_at), "h:mm a")}</span>
            {call.duration_seconds > 0 && (
              <span>· {formatTime(call.duration_seconds)}</span>
            )}
          </div>
        </div>

        {call.recording_url && (
          <div className="flex items-center gap-2 mt-2.5">
            {audioBlobUrl && <audio ref={audioRef} src={audioBlobUrl} preload="metadata" />}

            {loadingAudio ? (
              <div className="flex items-center justify-center h-9 w-full">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : audioError ? (
              <div className="text-xs text-destructive py-1">Failed to load recording</div>
            ) : (
              <>
                <Button
                  type="button"
                  variant="default"
                  size="icon"
                  onClick={togglePlayback}
                  disabled={!audioBlobUrl}
                  className="h-8 w-8 rounded-full shrink-0"
                >
                  {isPlaying ? (
                    <Pause className="h-4 w-4 fill-current" />
                  ) : (
                    <Play className="h-4 w-4 fill-current ml-0.5" />
                  )}
                </Button>

                <div
                  className="flex-1 h-1.5 bg-muted-foreground/25 rounded-full cursor-pointer relative"
                  onClick={handleSeek}
                >
                  <div
                    className="h-full bg-primary rounded-full transition-all duration-100"
                    style={{ width: `${progress}%` }}
                  />
                  {progress > 0 && (
                    <div
                      className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 bg-primary rounded-full"
                      style={{ left: `calc(${progress}% - 5px)` }}
                    />
                  )}
                </div>

                <span className="text-xs text-muted-foreground min-w-[34px] text-right tabular-nums">
                  {formatTime(displayTime)}
                </span>

                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={handleDownload}
                  className="h-7 w-7 text-muted-foreground hover:text-foreground shrink-0"
                  title="Download recording"
                >
                  <Download className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
          </div>
        )}

        {call.notes && (
          <p className="mt-2 text-xs text-muted-foreground italic">{call.notes}</p>
        )}

        {call.outcome && (
          <div className="mt-2">
            <span
              className={cn(
                "inline-block text-[11px] font-medium px-2 py-0.5 rounded-full capitalize",
                call.outcome === "interested" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
                call.outcome === "callback" && "bg-amber-500/15 text-amber-700 dark:text-amber-300",
                call.outcome === "not_interested" && "bg-destructive/15 text-destructive",
                call.outcome === "voicemail" && "bg-sky-500/15 text-sky-700 dark:text-sky-300",
                !["interested", "callback", "not_interested", "voicemail"].includes(call.outcome) &&
                  "bg-muted text-muted-foreground"
              )}
            >
              {call.outcome.replace(/_/g, " ")}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
