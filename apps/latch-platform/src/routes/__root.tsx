import { useState } from "react"
import { HeadContent, Scripts, createRootRoute } from "@tanstack/react-router"
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools"
import { TanStackDevtools } from "@tanstack/react-devtools"
import { ThemeProvider } from "next-themes"
import { PanelLeft } from "lucide-react"
import { ThemeOverridesApplier } from "@intentface/latch-ui"

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

function RootDocument({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(true)
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <ThemeOverridesApplier />
          {/* Grey app canvas; the main content floats as an inset rounded panel. */}
          <div className="bg-base flex h-screen overflow-hidden">
            <AppSidebar open={sidebarOpen} />
            <main className="min-h-0 flex-1 py-2 pr-2">
              <div className="bg-secondary border-primary-border flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border shadow-sm">
                <div className="flex h-10 shrink-0 items-center px-2">
                  <button
                    type="button"
                    onClick={() => setSidebarOpen((o) => !o)}
                    aria-label="Toggle sidebar"
                    className="text-ink-tertiary hover:bg-primary-hover hover:text-ink-primary grid size-7 place-items-center rounded-md transition-colors"
                  >
                    <PanelLeft className="size-4" />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto">{children}</div>
              </div>
            </main>
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
