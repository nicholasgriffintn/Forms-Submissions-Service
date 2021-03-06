'use strict';

const AWS = require('aws-sdk');
AWS.config.update({ region: process.env.AWS_REGION || 'eu-west-1' });
const documentClient = new AWS.DynamoDB.DocumentClient();
const SES = new AWS.SES();

const { validate } = require('deep-email-validator');
const { verify } = require('hcaptcha');

const sanitize = (string) => {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
    '/': '&#x2F;',
  };
  const reg = /[&<>"'/]/gi;
  return string.replace(reg, (match) => map[match]);
};

const validateEmail = (email) => {
  const re =
    /^(([^<>()[\]\\.,;:\s@"]+(\.[^<>()[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  return re.test(String(email).toLowerCase());
};

const verifyEmail = async (email) => {
  const result = await validate({
    email: email,
    sender: 'inbox@nicholasgriffin.dev',
    validateRegex: true,
    validateMx: true,
    validateTypo: false,
    validateDisposable: true,
    validateSMTP: false,
  });
  return result;
};

const sendEmail = async function (formData) {
  const getContent = (formData) => {
    let retval = '';
    for (var attribName in formData) {
      retval += attribName + ': ' + formData[attribName] + '\n\n';
    }
    return retval;
  };

  return new Promise(async (resolve, reject) => {
    const emailParams = {
      Source: process.env.FROM_EMAIL,
      ReplyToAddresses: [process.env.FROM_EMAIL],
      Destination: {
        ToAddresses: [process.env.TO_EMAIL],
      },
      Message: {
        Body: {
          Text: {
            Charset: 'UTF-8',
            Data: getContent(formData),
          },
        },
        Subject: {
          Charset: 'UTF-8',
          Data: 'New Form Submission',
        },
      },
    };

    console.log(emailParams);

    try {
      const result = await SES.sendEmail(emailParams).promise();
      console.log('sendEmail result: ', result);
      resolve(result);
    } catch (err) {
      console.error('sendEmail error: ', err);
      reject(err);
    }
  });
};

const saveFormData = async (formData) => {
  return new Promise((resolve, reject) => {
    const params = {
      TableName: process.env.TABLE_NAME,
      Item: {
        formId: Math.floor(Math.random() * Math.floor(10000000)).toString(),
        formData: JSON.stringify(formData),
        created: Math.floor(Date.now() / 1000).toString(),
      },
    };

    documentClient.put(params, function (err, data) {
      if (err) {
        console.error(err);
        reject(err);
      } else resolve(data);
    });
  });
};

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'OPTIONS,POST',
};

// Main Lambda entry point
exports.handler = async (event) => {
  const formData =
    event.body && typeof event.body === 'string'
      ? JSON.parse(event.body)
      : event.body;

  try {
    if (formData) {
      const formSubmission = {};

      if (formData.honey) {
        return {
          statusCode: 200,
          body: JSON.stringify({
            status: 'Success',
            message: 'Thanks for the submission! It has been recieved.',
          }),
          headers,
        };
      }

      if (!formData.captcha) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            status: 'error',
            message: 'No captcha was provided.',
          }),
          headers,
        };
      }

      const captchaVerification = await verify(
        process.env.HCAPTCHA_SECRET,
        formData.captcha
      );

      if (!captchaVerification || captchaVerification.success !== true) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            status: 'error',
            message: 'Captcha verification failed!',
          }),
          headers,
        };
      }

      if (formData.name) {
        formSubmission.name = sanitize(formData.name);
      } else {
        return JSON.stringify({
          statusCode: 400,
          body: JSON.stringify({
            status: 'error',
            message: `No name was provided`,
          }),
          headers,
        });
      }
      if (formData.email) {
        if (validateEmail(formData.email)) {
          const emailVerification = await verifyEmail(formData.email);

          if (!emailVerification || emailVerification.valid !== true) {
            return {
              statusCode: 400,
              body: JSON.stringify({
                status: 'error',
                message: `The email provided is invalid for the reason: ${emailVerification.reason}`,
                info: emailVerification,
              }),
              headers,
            };
          } else {
            formSubmission.email = sanitize(formData.email);
          }
        } else {
          return {
            statusCode: 400,
            body: JSON.stringify({
              status: 'error',
              message: `The email provided could not be validated.`,
              info: emailVerification,
            }),
            headers,
          };
        }
      } else {
        return {
          statusCode: 400,
          body: JSON.stringify({
            status: 'error',
            message: `No email address was provided`,
          }),
          headers,
        };
      }
      if (formData.subject) {
        formSubmission.subject = sanitize(formData.subject);
      } else {
        return {
          statusCode: 400,
          body: JSON.stringify({
            status: 'error',
            message: `No subject was provided`,
          }),
          headers,
        };
      }
      if (!formData.message && !formData.upload) {
        return {
          statusCode: 400,
          body: JSON.stringify({
            status: 'error',
            message: `No message or upload was provided`,
          }),
          headers,
        };
      }
      if (formData.message) {
        formSubmission.message = sanitize(formData.message);
      }
      if (formData.upload) {
        formSubmission.upload = sanitize(formData.upload);
      }

      await Promise.all([
        saveFormData(formSubmission),
        sendEmail(formSubmission),
      ]);

      return {
        statusCode: 200,
        body: JSON.stringify({
          status: 'Success',
          message:
            "Thanks for the submission! It has been recieved, I'll get back to you soon.",
        }),
        headers,
      };
    } else {
      return {
        statusCode: 500,
        body: JSON.stringify({
          status: 'Error',
          message: 'No form data was submitted',
        }),
        headers,
      };
    }
  } catch (err) {
    console.error('handler error: ', err);

    return {
      statusCode: 500,
      body: JSON.stringify({ status: 'Error' }),
      headers,
    };
  }
};
