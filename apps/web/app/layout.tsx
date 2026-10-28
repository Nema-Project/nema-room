import type { Metadata } from "next";
import localFont from "next/font/local";
import { I18nProvider } from "@/lib/i18n";
import { runtimeHubUrl } from "@/lib/runtimeHubUrl";
import { AppReleaseBanner } from "@/components/AppRelease";
import { DesktopTitlebar } from "@/components/DesktopTitlebar";
import { ThreadWindowsProvider } from "@/components/ThreadWindowsProvider";
import "./globals.css";

// Committed faces so `next build` does not download Google Fonts.
// Inter variable: rsms/inter v4.1 (OFL, fonts/inter). Weights 400–700 match the previous Inter() call.
// JetBrains Mono Medium: v2.304 weight 500 (OFL, fonts/jetbrains-mono).
const inter = localFont({
  src: "./fonts/inter/InterVariable.woff2",
  weight: "400 700",
  style: "normal",
  variable: "--font-inter",
  display: "swap",
});
const mono = localFont({
  src: "./fonts/jetbrains-mono/JetBrainsMono-Medium.woff2",
  weight: "500",
  style: "normal",
  variable: "--font-mono",
  display: "swap",
});

// The published image reads NEMA_HUB_URL when a request arrives. A prerendered
// page would freeze the build-time fallback into the HTML.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Nema Room",
  description: "根回し — a chat-first project knowledge room",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const hubUrl = runtimeHubUrl();
  return (
    // lang is corrected on the client by I18nProvider to follow the UI locale.
    <html lang="en" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: `window.__NEMA_HUB_URL__=${JSON.stringify(hubUrl)}` }} />
        <script dangerouslySetInnerHTML={{ __html: `try{if(localStorage.getItem("nema.theme")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}` }} />
        <I18nProvider>
          <ThreadWindowsProvider>
            <DesktopTitlebar />
            <AppReleaseBanner />
            {children}
          </ThreadWindowsProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
