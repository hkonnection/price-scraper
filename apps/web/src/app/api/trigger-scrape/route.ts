import { getRequestContext } from '@cloudflare/next-on-pages';

export const runtime = 'edge';

/**
 * Derives the GitHub Actions workflow filename from a retailer slug.
 * Convention: `scrape-{slug}.yml` for all retailers except costco which uses `scrape.yml`.
 *
 * @param {string} slug - The retailer slug (e.g. 'nike', 'indigo', 'costco')
 * @returns {string} The workflow filename
 */
function getWorkflowFile(slug: string): string {
  return slug === 'costco' ? 'scrape.yml' : `scrape-${slug}.yml`;
}

/**
 * POST /api/trigger-scrape
 * Triggers the GitHub Actions scraper workflow for a specific retailer.
 *
 * @param request - Request with optional JSON body { retailer: string }
 */
export async function POST(request: Request) {
  try {
    const { env } = getRequestContext();
    const token = (env as { GITHUB_TOKEN?: string }).GITHUB_TOKEN;

    if (!token) {
      return Response.json(
        { error: 'GitHub token not configured' },
        { status: 500 }
      );
    }

    // Get retailer from request body, default to costco
    let retailer = 'costco';
    try {
      const body = await request.json() as { retailer?: string };
      if (body.retailer) {
        retailer = body.retailer;
      }
    } catch {
      // No body or invalid JSON, use default
    }

    const workflowFile = getWorkflowFile(retailer);

    const response = await fetch(
      `https://api.github.com/repos/hkonnection/price-scraper/actions/workflows/${workflowFile}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'price-scraper-app',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );

    if (response.ok || response.status === 204) {
      return Response.json({
        success: true,
        message: 'Scraper triggered successfully. Deals will update shortly.'
      });
    }

    const errorText = await response.text();
    console.error('GitHub API error:', response.status, errorText);

    return Response.json(
      { error: 'Failed to trigger scraper', details: errorText },
      { status: response.status }
    );
  } catch (error) {
    console.error('Trigger error:', error);
    return Response.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
