/** Native Pi hosts and Web clients share these authenticated TravelService operations. */
export function registerTravelRuntimeRoutes({ app, asyncRoute, requireTripMember, travelService }) {
  const post = (path, method, fields, { cancellable = false } = {}) => {
    app.post(`/api/trips/:tripId/${path}`, asyncRoute(async (request, response) => {
      await requireTripMember(request, request.params.tripId);
      const input = Object.fromEntries(fields.filter((field) => request.body?.[field] !== undefined).map((field) => [field, request.body[field]]));
      input.tripId = request.params.tripId;
      const controller = new AbortController();
      const abort = () => { if (!response.writableEnded) controller.abort(); };
      if (cancellable) {
        input.signal = controller.signal;
        request.once("aborted", abort);
        response.once("close", abort);
      }
      try {
        const result = await travelService[method](input);
        if (!controller.signal.aborted) response.json(result);
      } finally {
        request.off("aborted", abort);
        response.off("close", abort);
      }
    }));
  };
  post("scope", "updateTripScope", ["brief", "travelerCount", "language", "foreignGuestRequired", "travelerProfiles"]);
  post("research", "researchTripOptions", ["capability", "query", "question", "domains", "criteria"], { cancellable: true });
  post("itinerary-trials", "planItineraryTrial", ["plan", "baselinePreviewId"], { cancellable: true });
  post("booking-handoffs", "prepareBookingHandoff", ["nodeId", "offerId", "explicitUserConfirmation"]);
  post("booking-confirmations", "recordBookingConfirmation", ["nodeId", "offerId", "confirmationRef", "baseRevision", "explicitUserConfirmation"]);
  post("disruptions", "reportTripDisruption", ["proposal"]);
}
