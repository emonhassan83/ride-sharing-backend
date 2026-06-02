import catchAsync from '../../utils/catchAsync'
import httpStatus from 'http-status'
import sendResponse from '../../utils/sendResponse'
import { FaqService } from './faq.service'

const createFaq = catchAsync(async (req, res) => {
  const result = await FaqService.createFaqIntoDB(req.body)

  sendResponse(res, {
    code: httpStatus.CREATED,
    message: 'Faq create successfully!',
    data: result,
  })
})

const getAllFaqs = catchAsync(async (req, res) => {
  const result = await FaqService.getAllFaqsFromDB(req.query)

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'Faqs retrieved successfully!',
    data: result,
  })
})

const updateFaq = catchAsync(async (req, res) => {
  const result = await FaqService.updateFaqFromDB(
    req.params.id as string,
    req.body
  )

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'Faq update successfully!',
    data: result,
  })
})

const deleteAFaq = catchAsync(async (req, res) => {
  const result = await FaqService.deleteAFaqFromDB(req.params.id as string)

  sendResponse(res, {
    code: httpStatus.OK,
    message: 'Faq delete successfully!',
    data: result,
  })
})

export const FaqControllers = {
  createFaq,
  getAllFaqs,
  updateFaq,
  deleteAFaq,
}
