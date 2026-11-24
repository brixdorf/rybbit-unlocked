import { eq } from "drizzle-orm";
import { FastifyReply, FastifyRequest } from "fastify";
import { db } from "../../db/postgres/postgres.js";
import { gscConnections } from "../../db/postgres/schema.js";
import { GetGSCStatusRequest } from "./types.js";

/**
 * Checks if a site has an active GSC connection
 */
export async function getGSCStatus(req: FastifyRequest<GetGSCStatusRequest>, res: FastifyReply) {
  try {
    const { siteId } = req.params;
    const numericSiteId = Number(siteId);

    if (isNaN(numericSiteId)) {
      return res.status(400).send({ error: "Invalid site ID" });
    }

    // rybbit-unlocked: lets the client explain a missing Google OAuth setup instead of failing after a click
    const oauthConfigured = !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;

    const [connection] = await db.select().from(gscConnections).where(eq(gscConnections.siteId, numericSiteId));

    if (!connection) {
      return res.send({
        connected: false,
        gscPropertyUrl: null,
        oauthConfigured,
      });
    }

    return res.send({
      connected: true,
      gscPropertyUrl: connection.gscPropertyUrl,
      oauthConfigured,
    });
  } catch (error) {
    req.log.error(error, "Error checking GSC status");
    return res.status(500).send({ error: "Failed to check GSC status" });
  }
}
