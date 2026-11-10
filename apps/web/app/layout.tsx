import type { Metadata } from "next";
import localFont from "next/font/local";
import { I18nProvider } from "@/lib/i18n";
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

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Nema Room",
  description: "根回し — a chat-first project knowledge room",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // lang is corrected on the client by I18nProvider to follow the UI locale.
    <html lang="en" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: `try{if(localStorage.getItem("nema.theme")==="dark")document.documentElement.dataset.theme="dark"}catch(e){}` }} />
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  );
}
