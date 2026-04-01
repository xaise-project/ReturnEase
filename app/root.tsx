import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from "@remix-run/react";

export default function App() {
  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();

  let title = "Something went wrong";
  let message = "An unexpected error occurred. Please try again.";
  let status = 500;

  if (isRouteErrorResponse(error)) {
    status = error.status;
    if (status === 404) {
      title = "Page not found";
      message = "The page you're looking for doesn't exist.";
    } else if (status === 401 || status === 403) {
      title = "Access denied";
      message = "You don't have permission to view this page.";
    } else {
      message = error.data?.message || error.statusText || message;
    }
  } else if (error instanceof Error) {
    message = error.message;
  }

  return (
    <html>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{title} — ReturnEase</title>
        <Meta />
        <Links />
      </head>
      <body>
        <div style={{
          minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: "Inter, -apple-system, sans-serif", background: "#F9FAFB",
        }}>
          <div style={{
            textAlign: "center", maxWidth: 480, padding: "40px 24px",
            background: "#fff", borderRadius: 16, boxShadow: "0 4px 24px rgba(0,0,0,0.08)",
          }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>
              {status === 404 ? "🔍" : status === 401 || status === 403 ? "🔒" : "⚠️"}
            </div>
            <div style={{ fontSize: 13, fontWeight: 700, color: "#6366F1", letterSpacing: 1, marginBottom: 8, textTransform: "uppercase" }}>
              Error {status}
            </div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: "#111827", margin: "0 0 12px" }}>
              {title}
            </h1>
            <p style={{ fontSize: 14, color: "#6B7280", lineHeight: 1.6, margin: "0 0 24px" }}>
              {message}
            </p>
            <a
              href="/"
              style={{
                display: "inline-block", padding: "10px 24px", borderRadius: 8,
                background: "#6366F1", color: "#fff", textDecoration: "none",
                fontSize: 14, fontWeight: 600,
              }}
            >
              Go back home
            </a>
          </div>
        </div>
        <Scripts />
      </body>
    </html>
  );
}
