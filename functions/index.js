const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2/options");
const admin = require("firebase-admin");
const crypto = require("crypto");

// Gen 2 supports Node.js 24; Gen 1 HTTP functions do not — avoids empty deployments.
setGlobalOptions({
  region: "africa-south1",
  maxInstances: 10,
});

admin.initializeApp();
const db = admin.firestore();

// Serve public config to frontend (CORS handled by Gen 2 option — no cors npm package).
exports.getConfig = onRequest({ cors: true, invoker: "public" }, (req, res) => {
  // Env names cannot use reserved FIREBASE_ prefix in functions/.env (Firebase CLI).
  res.status(200).json({
    paystackPublicKey: process.env.PAYSTACK_PUBLIC_KEY,
    firebaseConfig: {
      apiKey: process.env.CLIENT_FB_API_KEY,
      authDomain: process.env.CLIENT_FB_AUTH_DOMAIN,
      projectId: process.env.CLIENT_FB_PROJECT_ID,
      storageBucket: process.env.CLIENT_FB_STORAGE_BUCKET,
      messagingSenderId: process.env.CLIENT_FB_MESSAGING_SENDER_ID,
      appId: process.env.CLIENT_FB_APP_ID,
      measurementId: process.env.CLIENT_FB_MEASUREMENT_ID,
    },
  });
});

exports.paystackWebhook = onRequest({ cors: false, invoker: "public" }, async (req, res) => {
  const secret = process.env.PAYSTACK_SECRET_KEY;
  if (!secret) {
    console.error("PAYSTACK_SECRET_KEY not configured");
    return res.status(500).send("Server misconfigured");
  }

  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  const rawPayload = req.rawBody;
  if (!Buffer.isBuffer(rawPayload)) {
    console.error("Webhook missing rawBody");
    return res.status(400).send("Bad request");
  }

  const hash = crypto.createHmac("sha512", secret).update(rawPayload).digest("hex");

  if (hash !== req.headers["x-paystack-signature"]) {
    console.error("Unauthorized webhook attempt.");
    return res.status(401).send("Invalid signature");
  }

  let event;
  try {
    event = JSON.parse(rawPayload.toString("utf8"));
  } catch {
    return res.status(400).send("Invalid JSON");
  }

  if (event.event === "charge.success") {
    const reference = event.data.reference;
    const amountPaidCents = event.data.amount;

    try {
      const ordersSnapshot = await db.collectionGroup("orders").where("reference", "==", reference).get();

      if (ordersSnapshot.empty) {
        return res.status(200).send("Order not found, but acknowledged");
      }

      const orderDoc = ordersSnapshot.docs[0];
      const orderData = orderDoc.data();
      const expectedAmountCents = orderData.totalAmount * 100;

      if (amountPaidCents >= expectedAmountCents) {
        await orderDoc.ref.update({
          status: "Paid - Processing",
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          paystackId: event.data.id,
        });
      } else {
        await orderDoc.ref.update({
          status: "Error - Underpaid",
          paidAmountCents: amountPaidCents,
        });
      }
    } catch (error) {
      console.error("Error processing webhook:", error);
    }
  }

  res.status(200).send("Webhook received");
});
