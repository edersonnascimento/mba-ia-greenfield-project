import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoForbiddenException extends DomainException {
  constructor() {
    super('VIDEO_FORBIDDEN', 403, 'You do not own this video');
  }
}

export class VideoInvalidStatusException extends DomainException {
  constructor() {
    super(
      'VIDEO_INVALID_STATUS',
      409,
      'Video is in an invalid status for this operation',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready');
  }
}

export class VideoObjectVerificationFailedException extends DomainException {
  constructor() {
    super(
      'VIDEO_OBJECT_VERIFICATION_FAILED',
      409,
      'Uploaded object does not match the expected size',
    );
  }
}
