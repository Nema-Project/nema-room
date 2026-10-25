import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { I18nProvider } from "@/lib/i18n";
import { DesktopTitlebar } from "@/components/DesktopTitlebar";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-inter", display: "swap" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["500"], variable: "--font-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Nema Room",
  description: "根回し — a chat-first project knowledge room",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // lang is corrected on the client by I18nProvider to follow the UI locale.
    <html lang="en" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <body>
        <I18nProvider>
          <DesktopTitlebar />
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
