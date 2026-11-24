import { runtimeHubUrl } from "@/lib/runtimeHubUrl";

// Like the room layout: the published image reads NEMA_HUB_URL per request, and the login form must
// post to the same hub origin the room calls, so the address is written before hydration.
export const dynamic = "force-dynamic";

export default function LoginLayout({ children }: { children: React.ReactNode }) {
  const hubUrl = runtimeHubUrl();
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: `window.__NEMA_HUB_URL__=${JSON.stringify(hubUrl)}` }} />
      {children}
    </>
  );
}
