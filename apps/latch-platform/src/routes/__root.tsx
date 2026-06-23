import { HeadContent, Scripts, createRootRoute, useRouterState } from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"
import { TanStackDevtools } from "@tanstack/react-devtools"
import { ThemeProvider } from "next-themes"
import { Sidebar, ThemeOverridesApplier } from "@intentface/latch-ui"

import { AppSidebar } from "@/components/app-sidebar"
import { Toaster } from "@/components/ui/sonner"
import appCss from "../styles.css?url"

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "TanStack Start Starter",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
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

/** Auth routes render full-screen, without the app shell (sidebar/canvas). */
const AUTH_ROUTES = ["/login", "/reset-password"];

function RootDocument({ children }: { children: React.ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isAuthRoute = AUTH_ROUTES.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <ThemeOverridesApplier />
          {isAuthRoute ? (
            // Standalone auth screens: full-viewport canvas, no sidebar.
            <div className="bg-base h-svh w-full">{children}</div>
          ) : (
            // Sidebar system: grey app canvas, collapsible offcanvas sidebar, and
            // a floating white content panel (the Inset + Viewport).
            <Sidebar.Provider>
              <AppSidebar />
              <Sidebar.Inset>
                <Sidebar.Viewport>
                  {/* Floating trigger — overlays the top-left of the white panel so
                      the full content area scrolls to the very top (no fixed bar).
                      Inside the Viewport so it insets from the panel edge. */}
                  <header className="pointer-events-none absolute inset-x-0 top-0 z-20 flex items-center p-2">
                    <Sidebar.Trigger className="pointer-events-auto" />
                  </header>
                  <div className="h-full overflow-auto">{children}</div>
                </Sidebar.Viewport>
              </Sidebar.Inset>
            </Sidebar.Provider>
          )}
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
