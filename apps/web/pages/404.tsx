import Head from "next/head";
import { ShareUnavailable } from "@/components/ShareView";

export default function ShareNotFound() {
  return <><Head><meta name="robots" content="noindex, nofollow" /></Head><ShareUnavailable /></>;
}
