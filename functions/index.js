const { onRequest } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2/options");
const admin = require("firebase-admin");
const { Resend } = require("resend");
const crypto = require("crypto");

// Gen 2 supports Node.js 24; Gen 1 HTTP functions do not — avoids empty deployments.
setGlobalOptions({
  region: "africa-south1",
  maxInstances: 10,
});

admin.initializeApp();
const db = admin.firestore();
const resendApiKey = process.env.RESEND_API_KEY;
const resend = resendApiKey ? new Resend(resendApiKey) : null;
const supportEmail = process.env.SUPPORT_EMAIL || "support@yanoskicks.co.za";
const ordersEmail = process.env.ORDERS_EMAIL || "orders@yanoskicks.co.za";
const senderEmail = process.env.ORDER_SENDER_EMAIL || "Yanos Kicks <orders@yanoskicks.co.za>";

function formatZar(amount) {
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency: "ZAR",
    minimumFractionDigits: 2,
  }).format(Number(amount || 0));
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getEstimatedShippingText(shippingMethod) {
  if (String(shippingMethod || "").toLowerCase().includes("overnight")) {
    return "Overnight Express: usually next business day for major areas.";
  }
  return "Standard Delivery: usually 2-4 business days.";
}

function buildOrderEmailHtml(orderData) {
  const items = Array.isArray(orderData.items) ? orderData.items : [];
  const rows = items.map((item) => {
    const qty = Number(item.qty) > 0 ? Number(item.qty) : 1;
    const unitPrice = Number(item.price) || 0;
    const lineTotal = unitPrice * qty;
    return `
      <tr>
        <td style="padding:10px 8px;border-bottom:1px solid #ececec;">${escapeHtml(item.title || "Sneaker")}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #ececec;">UK ${escapeHtml(item.size || "N/A")}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #ececec;">${qty}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #ececec;text-align:right;">${formatZar(lineTotal)}</td>
      </tr>`;
  }).join("");

  const shippingEta = getEstimatedShippingText(orderData.shippingMethod);
  return `<!doctype html>
  <html>
    <body style="margin:0;padding:0;background:#f6f6f6;font-family:Arial,sans-serif;color:#050505;">
      <div style="max-width:680px;margin:0 auto;background:#ffffff;padding:24px;border:1px solid #ececec;">
        <h1 style="margin:0 0 8px;font-size:28px;letter-spacing:1px;">Yanos Kicks</h1>
        <p style="margin:0 0 20px;font-size:13px;color:#555;">Thank you for your order. Your payment has been confirmed.</p>

        <div style="background:#fafafa;border:1px solid #ececec;padding:14px;margin-bottom:18px;">
          <p style="margin:0 0 8px;"><strong>Order Ref:</strong> ${escapeHtml(orderData.reference)}</p>
          <p style="margin:0 0 8px;"><strong>Status:</strong> Paid - Processing</p>
          <p style="margin:0;"><strong>Total:</strong> ${formatZar(orderData.totalAmount)}</p>
        </div>

        <h2 style="font-size:16px;margin:0 0 8px;">Order items</h2>
        <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:16px;">
          <thead>
            <tr style="text-align:left;background:#fafafa;border-top:1px solid #ececec;border-bottom:1px solid #ececec;">
              <th style="padding:10px 8px;">Sneaker</th>
              <th style="padding:10px 8px;">Size</th>
              <th style="padding:10px 8px;">Qty</th>
              <th style="padding:10px 8px;text-align:right;">Line Total</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>

        <h2 style="font-size:16px;margin:0 0 8px;">Shipping</h2>
        <p style="margin:0 0 6px;"><strong>Method:</strong> ${escapeHtml(orderData.shippingMethod || "Standard Delivery")}</p>
        <p style="margin:0 0 6px;"><strong>ETA:</strong> ${escapeHtml(shippingEta)}</p>
        <p style="margin:0 0 16px;"><strong>Delivery:</strong> ${escapeHtml(orderData.deliveryAddress || "Provided at checkout")}</p>

        <p style="font-size:13px;color:#555;margin:0;">Need help? Email us at
          <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>
          or for order updates
          <a href="mailto:${escapeHtml(ordersEmail)}">${escapeHtml(ordersEmail)}</a>.
        </p>
      </div>
    </body>
  </html>`;
}

function buildOrderEmailText(orderData) {
  const itemsText = (Array.isArray(orderData.items) ? orderData.items : [])
    .map((item) => {
      const qty = Number(item.qty) > 0 ? Number(item.qty) : 1;
      return `${qty}x ${item.title || "Sneaker"} (UK ${item.size || "N/A"})`;
    })
    .join("\n");

  return [
    "Thank you for your order at Yanos Kicks.",
    "",
    `Order Ref: ${orderData.reference || "N/A"}`,
    "Status: Paid - Processing",
    `Total: ${formatZar(orderData.totalAmount)}`,
    "",
    "Items:",
    itemsText || "No items listed.",
    "",
    `Shipping Method: ${orderData.shippingMethod || "Standard Delivery"}`,
    `ETA: ${getEstimatedShippingText(orderData.shippingMethod)}`,
    `Delivery Address: ${orderData.deliveryAddress || "Provided at checkout"}`,
    "",
    `Support: ${supportEmail}`,
    `Order updates: ${ordersEmail}`,
  ].join("\n");
}

async function sendOrderConfirmationEmail({ orderRef, orderData, fallbackEmail }) {
  if (!resend) {
    console.warn("RESEND_API_KEY missing - skipping customer email for", orderRef);
    return { sent: false, reason: "missing_api_key" };
  }

  const toEmail = orderData.customerEmail || fallbackEmail;
  if (!toEmail) {
    console.warn("Customer email missing - skipping customer email for", orderRef);
    return { sent: false, reason: "missing_customer_email" };
  }

  await resend.emails.send({
    from: senderEmail,
    to: toEmail,
    replyTo: [supportEmail],
    subject: `Yanos Kicks: Order Confirmed (${orderRef})`,
    html: buildOrderEmailHtml(orderData),
    text: buildOrderEmailText(orderData),
  });

  return { sent: true, toEmail };
}

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
        const updatePayload = {
          status: "Paid - Processing",
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          paystackId: event.data.id,
        };

        if (!orderData.orderConfirmationEmailSentAt) {
          try {
            const result = await sendOrderConfirmationEmail({
              orderRef: reference,
              orderData,
              fallbackEmail: event.data?.customer?.email,
            });
            if (result.sent) {
              updatePayload.orderConfirmationEmailSentAt = admin.firestore.FieldValue.serverTimestamp();
              updatePayload.orderConfirmationEmailTo = result.toEmail;
            } else {
              updatePayload.orderConfirmationEmailError = result.reason;
            }
          } catch (emailError) {
            console.error("Order confirmation email failed:", emailError);
            updatePayload.orderConfirmationEmailError = String(emailError?.message || emailError);
          }
        }

        await orderDoc.ref.update(updatePayload);
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
