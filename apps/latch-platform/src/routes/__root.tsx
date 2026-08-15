import {
  HeadContent,
  Scripts,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"
import { TanStackDevtools } from "@tanstack/react-devtools"
import { ThemeProvider } from "next-themes"
import { Sidebar } from "@/components/ui/sidebar"
import { ThemeOverridesApplier } from "@/components/theme-overrides-applier"

import { AppSidebar } from "@/components/app-sidebar"
import { Toaster } from "@/components/ui/sonner"
import { ThemeContrast } from "@/components/theme-contrast"
import appCss from "../styles.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Latch" },
      {
        name: "description",
        content:
          "Latch — agents, MCP & OpenAPI connections, and scheduled runs on one AI backend.",
      },
      { name: "theme-color", content: "#111111" },
      { property: "og:title", content: "Latch" },
      {
        property: "og:description",
        content:
          "Agents, MCP & OpenAPI connections, and scheduled runs on one AI backend.",
      },
      { property: "og:type", content: "website" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      // The Latch face as an SVG favicon (modern browsers).
      { rel: "icon", type: "image/svg+xml", href: "/latch-face.svg" },
      { rel: "manifest", href: "/manifest.json" },
    ],
  }),
  notFoundComponent: () => (
    <main className="container mx-auto p-4 pt-16">
      <h1>404</h1>
      <p>The requested page could not be found.</p>
    </main>
  ),
  shellComponent: RootDocument,
})

/**
 * Routes that render full-screen, without the app shell (sidebar/canvas):
 * the logged-out landing (`/`) and the standalone auth screens. `/` only ever
 * shows logged-out (it redirects to /chat once signed in), so the shell never
 * appears until you're in.
 */
const SHELL_LESS_ROUTES = [
  "/",
  "/login",
  "/reset-password",
  "/accept-invitation",
]

function RootDocument({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const isAuthRoute = SHELL_LESS_ROUTES.some(
    (p) => pathname === p || (p !== "/" && pathname.startsWith(`${p}/`))
  )

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      {/* suppressHydrationWarning: browser extensions (Grammarly et al.) add
          attributes to <body> before React hydrates — same reason <html> has it. */}
      <body suppressHydrationWarning>
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          <ThemeOverridesApplier />
          <ThemeContrast />
          {/* The composer's command popover, panel, and attachment preview render
              through portals into <body>. Giving the app tree its own stacking
              context contains every z-index inside it, so those portaled siblings
              always paint above the layout. */}
          <div className="isolate h-full">
            {isAuthRoute ? (
              // Standalone auth screens: full-viewport canvas, no sidebar.
              <div className="h-svh w-full bg-base">{children}</div>
            ) : (
              // Sidebar system: grey app canvas, collapsible offcanvas sidebar, and
              // a floating white content panel (the Inset + Viewport).
              <Sidebar.Provider>
                <AppSidebar />
                <Sidebar.Inset>
                  <Sidebar.Viewport>
                    {/* No trigger out here: the sidebar's own header carries it
                      while open, and collapsed it comes back by resting the
                      pointer at the left edge (hover-peek) or Cmd/Ctrl+B. */}
                    {/* Sidebar.Viewport is a flex row, so this pane has to claim
                      the space explicitly — as a shrink-to-fit flex item it
                      collapses to the thread's min-width instead of filling. */}
                  <div className="h-full min-w-0 flex-1 overflow-auto">{children}</div>
                  </Sidebar.Viewport>
                </Sidebar.Inset>
              </Sidebar.Provider>
            )}
          </div>
          <Toaster />
        </ThemeProvider>
        <TanStackDevtools
          config={{
            position: "bottom-right",
          }}
          plugins={[
            {
              name: "Tanstack Router",
              render: <TanStackRouterDevtoolsPanel />,
            },
          ]}
        />
        <Scripts />
      </body>
    </html>
  )
}
