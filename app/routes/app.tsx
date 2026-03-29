import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import type { Locale } from "../services/i18n-admin";
import { getAdminTranslations } from "../services/i18n-admin";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  const settings = await prisma.storeSettings.findUnique({
    where: { shop: session.shop },
  });

  const locale = (settings?.locale || "en") as Locale;
  const t = getAdminTranslations(locale);

  return { apiKey: process.env.SHOPIFY_API_KEY || "", locale, t };
};

export default function App() {
  const { apiKey, locale, t } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">
          {t["nav.home"]}
        </Link>
        <Link to="/app/returns">{t["nav.returns"]}</Link>
        <Link to="/app/analytics">{t["nav.analytics"]}</Link>
        <Link to="/app/billing">{t["nav.billing"]}</Link>
        <Link to="/app/settings">{t["nav.settings"]}</Link>
      </NavMenu>
      <Outlet context={{ locale, t }} />
    </AppProvider>
  );
}

// Shopify needs Remix to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
