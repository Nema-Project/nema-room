import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { I18nProvider } from "@/lib/i18n";
import { runtimeHubUrl } from "@/lib/runtimeHubUrl";
import { AppReleaseBanner } from "@/components/AppRelease";
import { DesktopTitlebar } from "@/components/DesktopTitlebar";
import { ThreadWindowsProvider } from "@/components/ThreadWindowsProvider";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["500"], variable: "--font-mono", display: "swap" });

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
