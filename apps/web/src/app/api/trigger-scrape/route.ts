import { getRequestContext } from '@cloudflare/next-on-pages';

export const runtime = 'edge';

/**
 * POST /api/trigger-scrape
 * Triggers the GitHub Actions scraper workflow.
 */
export async function POST() {
  try {
    const { env } = getRequestContext();
    const token = (env as { GITHUB_TOKEN?: string }).GITHUB_TOKEN;

    if (!token) {
      return Response.json(
        { error: 'GitHub token not configured' },
        { status: 500 }
      );
    }

    const response = await fetch(
      'https://api.github.com/repos/hkonnection/price-scraper/actions/workflows/scrape.yml/dispatches',
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
