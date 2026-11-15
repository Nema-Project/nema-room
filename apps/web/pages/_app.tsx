import type { AppProps } from "next/app";
import Head from "next/head";
import localFont from "next/font/local";
import { I18nProvider } from "@/lib/i18n";
import "@/app/globals.css";

const inter = localFont({ src: "../app/fonts/inter/InterVariable.woff2", weight: "400 700", style: "normal", display: "swap" });
const mono = localFont({ src: "../app/fonts/jetbrains-mono/JetBrainsMono-Medium.woff2", weight: "500", style: "normal", display: "swap" });

export default function ShareApp({ Component, pageProps }: AppProps) {
  return <>
    <Head><style>{`:root { --font-inter: ${inter.style.fontFamily}; --font-mono: ${mono.style.fontFamily}; }`}</style></Head>
    <I18nProvider><Component {...pageProps} /></I18nProvider>
  </>;
}
