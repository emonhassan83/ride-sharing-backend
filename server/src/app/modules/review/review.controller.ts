import { StatusCodes } from 'http-status-codes';
import catchAsync from '../../utils/catchAsync';;
import sendResponse from '../../utils/sendResponse';
import { ReviewsService } from './review.service';

const createReviews = catchAsync(async (req, res) => {
  const result = await ReviewsService.createReviews(req.body, req.user.userId)
  sendResponse(res, {
    code: StatusCodes.CREATED,
    message: 'Reviews created successfully',
    data: result,
  })
})

const getReviewsByUser = catchAsync(
  async (req, res) => {
    const query = {
      ...req.query,
      user: req.params.userId,
    }
    const result = await ReviewsService.getAllReviews(query)

    sendResponse(res, {
      code: StatusCodes.OK,
      message: 'All bookings with expert fetched successfully',
      pagination: result.meta,
      data: result.data,
    })
  },
)

export const ReviewsController = {
  createReviews,
  getReviewsByUser
}
