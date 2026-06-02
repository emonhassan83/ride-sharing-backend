import express from 'express'
import { USER_ROLE } from '../user/user.constant'
import { MetaController } from './meta.controller'
import auth from '../../middlewares/auth'

const router = express.Router()

router.get('/', auth(USER_ROLE.admin), MetaController.fetchDashboardMetaData)

export const MetaRoutes = router