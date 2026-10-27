import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const origin = "https://www.marianmadrid.es";
const findings = [];
const screenshotDir = new URL("../../visual-evidence/", import.meta.url);
await mkdir(screenshotDir, { recursive: true });
const browser = await chromium.launch({ headless: true });

const cases = [
  {
    name: "homepage",
    path: "/",
    required: [/marian madrid/i],
    forbidden: [/hasta entonces nos vemos en nuestras redes/i],
  },
  {
    name: "service catalog",
    path: "/reserva-online",
    required: [/cat[aá]logo de servicios/i, /reserva/i],
    forbidden: [/lorem ipsum/i],
  },
  {
    name: "dual-phase service detail",
    path: "/service-page/babylights-mechas-naturales",
    required: [/babylights/i],
    forbidden: [/lorem ipsum/i],
  },
  {
    name: "Rayos V booking calendar",
    path: "/booking-calendar/rayos-v",
    required: [/rayos\s*v/i],
    forbidden: [/service not found/i, /servicio no encontrado/i],
    requireTime: true,
  },
  {
    name: "privacy policy",
    path: "/politica-privacidad-texto",
    required: [/titular/i],
    forbidden: [/\[incluir email de contacto\]/i, /\[número de identificación fiscal\]/i],
  },
];

try {
  for (const testCase of cases) {
    const page = await browser.newPage({ viewport: { width: 1365, height: 900 } });
    const pageErrors = [];
    const failedFirstPartyRequests = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("console", message => {
      if (message.type() === "error") pageErrors.push(message.text());
    });
    page.on("requestfailed", request => {
      if (/marianmadrid\.es|wixstatic\.com|wix\.com/i.test(request.url())) {
        failedFirstPartyRequests.push({
          url: request.url().slice(0, 180),
          error: request.failure()?.errorText || "unknown",
        });
      }
    });

    const url = new URL(testCase.path, origin).toString();
    const problems = [];
    let response;
    let visibleText = "";
    let title = "";
    let frameReport = [];
    let actionReport = [];
    try {
      response = await page.goto(url, { waitUntil: "commit", timeout: 20000 });
      await page.waitForTimeout(8000);
      await page.screenshot({ path: new URL(`${testCase.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.png`, screenshotDir).pathname, fullPage: false, timeout: 10000 }).catch(() => {});
      title = await page.title().catch(() => "");
      visibleText = (await page.locator("body").innerText({ timeout: 10000 }).catch(() => "")).replace(/\s+/g, " ").trim();
      if (!response?.ok()) problems.push(`HTTP ${response?.status() ?? "no response"}`);
      for (const marker of testCase.required || []) {
        if (!marker.test(visibleText)) problems.push(`missing visible content: ${marker}`);
      }
      for (const marker of testCase.forbidden || []) {
        if (marker.test(visibleText)) problems.push(`visible placeholder/maintenance content: ${marker}`);
      }
      if (testCase.requireTime && !/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(visibleText)) {
        problems.push("no visible appointment time detected");
      }

      frameReport = await Promise.all(page.frames().slice(0, 4).map(async frame => ({
        url: frame.url().slice(0, 180),
        text: (await frame.locator("body").innerText({ timeout: 1500 }).catch(() => "")).replace(/\s+/g, " ").trim().slice(0, 500),
      })));
      actionReport = await page.locator("a,button,[role=button]").evaluateAll(elements =>
        elements.filter(element => {
          const rect = element.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        }).slice(0, 15).map(element => ({
          tag: element.tagName,
          text: (element.innerText || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().slice(0, 90),
          href: element.getAttribute("href")?.slice(0, 160) || null,
          disabled: element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true",
        }))
      );

      const report = {
        route: testCase.name,
        url,
        finalUrl: page.url(),
        status: response?.status() ?? null,
        title,
        visibleTextSample: visibleText.slice(0, 1200),
        problems,
        pageErrors: pageErrors.slice(0, 10),
        failedFirstPartyRequests: failedFirstPartyRequests.slice(0, 10),
        frames: frameReport.slice(0, 8),
        visibleActions: actionReport,
      };
      console.log(JSON.stringify(report));
      if (problems.length) findings.push({ route: testCase.name, problems });
    } catch (error) {
      const report = {
        route: testCase.name,
        url,
        finalUrl: page.url(),
        title,
        error: error?.message || String(error),
        pageErrors: pageErrors.slice(0, 10),
        failedFirstPartyRequests: failedFirstPartyRequests.slice(0, 10),
      };
      console.log(JSON.stringify(report));
      findings.push({ route: testCase.name, problems: [report.error] });
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}

if (findings.length) {
  console.error(JSON.stringify({ summary: "LIVE SITE BROWSER CHECK FAILED", failures: findings }, null, 2));
  process.exitCode = 1;
} else {
  console.log("All public-site browser checks passed. No booking was submitted or created.");
}
