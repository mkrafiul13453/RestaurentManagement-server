import { AppError } from "../utils/app-error.js";

function isDuplicateKey(error) {
  return error?.code === 11000;
}

function serializeReview(review) {
  return {
    id: String(review._id),
    orderId: String(review.orderId),
    rating: review.rating,
    text: review.text,
    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  };
}

export function createReviewService({ Review, Order }) {
  return {
    async list({ userId, page, limit, orderIds }) {
      const filter = { userId };
      if (orderIds?.length) filter.orderId = { $in: orderIds };
      const [total, reviews] = await Promise.all([
        Review.countDocuments(filter),
        Review.find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
      ]);
      return {
        reviews: reviews.map(serializeReview),
        meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
      };
    },

    async create({ userId, orderId, rating, text }) {
      const order = await Order.findById(orderId).lean();
      if (!order || String(order.userId) !== String(userId)) {
        throw new AppError("Order not found", 404, "NOT_FOUND");
      }
      if (order.status !== "completed") {
        throw new AppError("Only completed orders can be reviewed", 409, "ORDER_NOT_COMPLETED");
      }

      try {
        const review = await Review.create({ userId, orderId, rating, text });
        return serializeReview(typeof review.toObject === "function" ? review.toObject() : review);
      } catch (error) {
        if (isDuplicateKey(error)) {
          throw new AppError("You have already reviewed this order", 409, "REVIEW_ALREADY_EXISTS");
        }
        throw error;
      }
    },
  };
}
