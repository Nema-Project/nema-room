import Head from "next/head";
import { ShareUnavailable, ShareView } from "./ShareView";
import type { SharePageProps } from "@/lib/sharePage";

export function SharePage(props: SharePageProps) {
  return <>
    <Head>
      <title>{props.workspaceName || "Nema Room"}</title>
      <meta name="robots" content="noindex, nofollow" />
      <link rel="icon" href="/icon.png" />
    </Head>
    {props.temporary ? <ShareUnavailable temporary /> : <ShareView {...props} />}
  </>;
}
