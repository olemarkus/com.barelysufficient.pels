import { carAssociationApi } from '../../lib/app/carAssociationApi';
import { defineRoutes } from './defineRoutes';

export const carLinkRoutes = defineRoutes(carAssociationApi);
