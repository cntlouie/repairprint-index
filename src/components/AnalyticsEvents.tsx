"use client";

import type { Route } from "next";
import Link from "next/link";
import { useEffect, useRef } from "react";

import type { BrowserAnalyticsEvent } from "@/domain/analytics";

export function AnalyticsPageEvent({ event }: { event: BrowserAnalyticsEvent }) {
  const sent = useRef(false);
  useEffect(() => {
    if (sent.current) return;
    sent.current = true;
    sendAnalyticsEvent(event);
  }, [event]);
  return null;
}

export function AnalyticsLink({
  children,
  className,
  events,
  href,
}: Readonly<{
  children: React.ReactNode;
  className?: string;
  events: readonly BrowserAnalyticsEvent[];
  href: string;
}>) {
  return (
    <Link className={className} href={href as Route} onClick={() => events.forEach(sendAnalyticsEvent)}>
      {children}
    </Link>
  );
}

export function AnalyticsExternalLink({
  children,
  className,
  event,
  href,
}: Readonly<{
  children: React.ReactNode;
  className?: string;
  event: BrowserAnalyticsEvent;
  href: string;
}>) {
  return (
    <a
      className={className}
      href={href}
      onClick={() => sendAnalyticsEvent(event)}
      rel="noopener noreferrer"
    >
      {children}
    </a>
  );
}

function sendAnalyticsEvent(event: BrowserAnalyticsEvent): void {
  try {
    void fetch("/api/v1/analytics/events", {
      body: JSON.stringify(event),
      credentials: "omit",
      headers: { "content-type": "application/json" },
      keepalive: true,
      method: "POST",
      referrerPolicy: "no-referrer",
    }).catch(() => undefined);
  } catch {
    // Analytics never changes navigation or page behavior.
  }
}
