// Indices into MediaPipe's 478-point face mesh. "R"/"L" are the subject's
// right/left (R appears on the image's left side for a front-facing photo).

export const FACE_OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377,
  152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];

export const LIPS_OUTER = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
export const LIPS_INNER = [78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13, 82, 81, 80, 191];

export const EYE_R = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
export const EYE_L = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];

// Upper eyelid and lower brow edge, both ordered outer corner -> inner corner.
export const LID_R = [33, 246, 161, 160, 159, 158, 157, 173, 133];
export const LID_L = [263, 466, 388, 387, 386, 385, 384, 398, 362];
export const BROW_LOWER_R = [46, 53, 52, 65, 55];
export const BROW_LOWER_L = [276, 283, 282, 295, 285];

export const BROW_R = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46];
export const BROW_L = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276];

export const IRIS_R = [468, 469, 470, 471, 472];
export const IRIS_L = [473, 474, 475, 476, 477];

// Lower face outline from the left cheek over the chin to the right cheek.
export const LOWER_OVAL = [454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58,
  132, 93, 234];

export const JAW_R = [93, 132, 58, 172, 136, 150];
export const JAW_L = [323, 361, 288, 397, 365, 379];

export const P = {
  forehead: 10,
  chin: 152,
  noseTip: 1,
  noseBridge: 6,
  noseBottom: 2,
  noseWingR: 98,
  noseWingL: 327,
  mouthR: 61,
  mouthL: 291,
  cheekR: 205,
  cheekL: 425,
  faceR: 234,
  faceL: 454,
};
