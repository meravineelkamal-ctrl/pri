const express = require("express");
const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const tranzupiToken = process.env.TRANZUPI_USER_TOKEN;
if (!serviceAccountJson) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable");
}
if (!tranzupiToken) {
  throw new Error("Missing TRANZUPI_USER_TOKEN environment variable");
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(serviceAccountJson);
} catch (error) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON");
}

if (getApps().length === 0) {
  initializeApp({ credential: cert(serviceAccount) });
}

const db = getFirestore();
const app = express();
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
app.use(express.json({ limit: "10kb" }));

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.post("/api/webhook", async (req, res) => {
  const orderId = String(req.body?.order_id || "").trim();
  const callbackAmount = Number(req.body?.amount);
  if (!orderId || orderId.length > 128 || orderId.includes("/")
    || !Number.isFinite(callbackAmount) || callbackAmount <= 0) {
    res.status(400).send("Invalid order_id or amount");
    return;
  }

  try {
    const verifyResponse = await fetch("https://tranzupi.com/api/check-order-status", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_token: tranzupiToken,
        order_id: orderId
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!verifyResponse.ok) {
      console.error("TranzUPI verification HTTP status:", verifyResponse.status);
      res.status(502).send("Payment verification unavailable");
      return;
    }

    const verification = await verifyResponse.json();
    const verifiedStatus = String(verification?.result?.status || "").toUpperCase();
    const verifiedAmount = Number(verification?.result?.amount);
    if (verifiedStatus !== "SUCCESS" || !Number.isFinite(verifiedAmount)) {
      res.status(202).send("Payment not confirmed");
      return;
    }
    if (Math.abs(verifiedAmount - callbackAmount) > 0.01) {
      res.status(400).send("Amount mismatch");
      return;
    }

    const orderRef = db.collection("orders").doc(orderId);
    await db.runTransaction(async transaction => {
      const orderSnapshot = await transaction.get(orderRef);
      if (!orderSnapshot.exists) throw new Error("ORDER_NOT_FOUND");

      const order = orderSnapshot.data();
      if (order.status === "paid") return;
      if (order.status !== "pending"
        || typeof order.uid !== "string"
        || typeof order.bookId !== "string"
        || !Number.isFinite(Number(order.amount))
        || Math.abs(Number(order.amount) - verifiedAmount) > 0.01) {
        throw new Error("ORDER_MISMATCH");
      }

      const bookRef = db.collection("books").doc(order.bookId);
      const fileRef = db.collection("bookFiles").doc(order.bookId);
      const [bookSnapshot, fileSnapshot] = await Promise.all([
        transaction.get(bookRef),
        transaction.get(fileRef)
      ]);
      if (!bookSnapshot.exists || !fileSnapshot.exists) throw new Error("BOOK_UNAVAILABLE");

      const purchaseRef = db.collection("users").doc(order.uid)
        .collection("purchases").doc(order.bookId);
      transaction.update(orderRef, {
        status: "paid",
        paidAt: FieldValue.serverTimestamp(),
        utr: String(req.body?.utr || "").slice(0, 64)
      });
      transaction.set(purchaseRef, {
        bookId: order.bookId,
        orderId,
        amount: verifiedAmount,
        purchasedAt: FieldValue.serverTimestamp()
      });
    });

    res.status(200).send("OK");
  } catch (error) {
    if (["ORDER_NOT_FOUND", "ORDER_MISMATCH", "BOOK_UNAVAILABLE"].includes(error.message)) {
      console.error("Verified payment could not be matched to a pending order:", error.message);
      res.status(409).send("Order not ready for fulfillment");
      return;
    }
    console.error("TranzUPI webhook processing failed:", error.message);
    res.status(500).send("Webhook processing failed");
  }
});

const port = Number(process.env.PORT) || 10000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Webhook server listening on port ${port}`);
});
